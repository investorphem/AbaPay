'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AIRTIME_SEED, DATA_SEED, ELECTRICITY_SEED, CABLE_SEED, EDUCATION_SEED,
  type SeedService,
} from '@/lib/providerFallback';

// ⚡ THE WEB APP'S SIDE OF THE LIVE CATALOGUE.
//
// Replaces the static CABLE_PROVIDERS_LIST / INTERNET_PROVIDERS / EDUCATION_PROVIDERS /
// TELECOM_PROVIDERS / ELECTRICITY_DISCOS imports in the provider pickers. VTpass credentials
// are server-only, so the browser reads /api/providers, which sits on the same 1h module cache
// chat and MCP use — one source of truth, no second implementation.
//
// The returned objects deliberately use the SAME keys the existing UI already reads
// (`serviceID`, `displayName`, `logo`, plus `disabled` added by the caller for kill switches),
// so every picker, modal and lookup renders unchanged. Only where the data comes from changed.

export interface UIProvider {
  serviceID: string;
  displayName: string;
  logo: string;
  minAmount: number | null;
  maxAmount: number | null;
}

export type ProviderCategory = 'airtime' | 'data' | 'electricity' | 'cable' | 'education';

const SEEDS: Record<ProviderCategory, SeedService[]> = {
  airtime: AIRTIME_SEED,
  data: DATA_SEED,
  electricity: ELECTRICITY_SEED,
  cable: CABLE_SEED,
  education: EDUCATION_SEED,
};

// 🔴 Module-level, not per-component: the pickers mount and unmount every time the user switches
// service tab. Without this, flipping Airtime -> Electricity -> Airtime fired three requests and
// flashed the seed list in between each time. Now the first mount pays for the fetch and every
// later mount renders the resolved list synchronously on its very first paint.
const memory = new Map<ProviderCategory, UIProvider[]>();
const inflight = new Map<ProviderCategory, Promise<UIProvider[]>>();

function seedOf(category: ProviderCategory): UIProvider[] {
  return SEEDS[category].map(s => ({
    serviceID: s.serviceID,
    displayName: s.displayName,
    logo: s.logo,
    minAmount: s.minAmount,
    maxAmount: s.maxAmount,
  }));
}

async function load(category: ProviderCategory): Promise<UIProvider[]> {
  const cached = memory.get(category);
  if (cached) return cached;

  const existing = inflight.get(category);
  if (existing) return existing;

  const p = (async () => {
    try {
      const res = await fetch(`/api/providers?category=${category}`);
      const data = await res.json();
      const list: UIProvider[] = Array.isArray(data?.providers) ? data.providers : [];
      if (list.length === 0) throw new Error('empty provider list');
      // A `stale` answer means the server fell back to its own cache/seed because VTpass was
      // unreachable. It is still the best list available and worth rendering — but it must NOT
      // be memoised as if it were live, or one blip would pin the degraded list for the whole
      // session with no way back short of a reload.
      if (!data?.stale) memory.set(category, list);
      return list;
    } catch (err) {
      // 🔴 Never blank the picker. A live-sourcing failure must not make buying a bill LOOK
      // broken when the vend path itself is perfectly healthy.
      console.error(`[Providers] Falling back to bundled list for "${category}":`, err);
      return seedOf(category);
    } finally {
      inflight.delete(category);
    }
  })();

  inflight.set(category, p);
  return p;
}

/**
 * The live provider list for one category. Always returns a renderable list: the bundled seed
 * on the very first paint, swapped for VTpass's live list as soon as it arrives.
 */
export function useProviders(category: ProviderCategory): { providers: UIProvider[]; isLoading: boolean } {
  const [providers, setProviders] = useState<UIProvider[]>(() => memory.get(category) || seedOf(category));
  const [isLoading, setIsLoading] = useState(() => !memory.has(category));

  useEffect(() => {
    let cancelled = false;
    const cached = memory.get(category);
    if (cached) { setProviders(cached); setIsLoading(false); return; }

    setIsLoading(true);
    load(category).then(list => {
      if (cancelled) return;
      setProviders(list);
      setIsLoading(false);
    });

    return () => { cancelled = true; };
  }, [category]);

  return { providers, isLoading };
}

/**
 * Keep a selected serviceID valid against the live list.
 *
 * 🔴 WHY THIS IS NEEDED: the whole point of live sourcing is that a service VTpass drops stops
 * being offered. But the pickers seed their state from the bundled list on first render, so
 * without this a user could be sitting on a provider that no longer exists — the picker button
 * would render blank (`providers.find(...)` -> undefined) and the form would submit a serviceID
 * VTpass rejects. If the current pick survives in the live list, nothing changes.
 */
export function useValidSelection(
  providers: UIProvider[],
  selected: string,
  onReset: (serviceID: string) => void,
) {
  useEffect(() => {
    if (providers.length === 0) return;
    if (providers.some(p => p.serviceID === selected)) return;
    onReset(providers[0].serviceID);
    // onReset is a setState-style callback; depending on it would re-run on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, selected]);
}

/** The live min/max for one selected provider, or nulls when VTpass publishes none. */
export function useProviderLimits(providers: UIProvider[], serviceID: string) {
  return useMemo(() => {
    const p = providers.find(x => x.serviceID === serviceID);
    return { min: p?.minAmount ?? null, max: p?.maxAmount ?? null };
  }, [providers, serviceID]);
}
