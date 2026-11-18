// A Nigerian mobile number's network, from its prefix — one table for every app.
//
// abapays.com (src/app/page.tsx) has always picked the airtime/data provider from the number. The
// NIM mini app (src/app/nim/NimApp.tsx) didn't, so a customer could buy Airtel airtime for an MTN
// number, which VTpass can only refuse (2026-11-05: 08145043264 as Airtel → 016 TRANSACTION FAILED,
// a NIM refund). Both apps read this module so the lists can't drift apart.
//
// Ported numbers keep their old prefix, so this is a default the customer can still change, not a
// rule the server enforces.

export type MobileNetwork = 'mtn' | 'airtel' | 'glo' | 'etisalat';

const PREFIXES: Record<MobileNetwork, readonly string[]> = {
  mtn: ['0803', '0806', '0810', '0813', '0814', '0816', '0903', '0906', '0913', '0916', '0703', '0706'],
  airtel: ['0802', '0808', '0812', '0902', '0907', '0912', '0701', '0708'],
  glo: ['0805', '0807', '0811', '0905', '0705', '0915'],
  etisalat: ['0809', '0817', '0818', '0908', '0909'],
};

/** The network a number's first four digits belong to, or null when unknown (or too short). */
export function networkForPhone(phone: string): MobileNetwork | null {
  const digits = String(phone || '').replace(/\D/g, '');
  const local = digits.startsWith('234') ? `0${digits.slice(3)}` : digits;
  if (local.length < 4) return null;
  const prefix = local.slice(0, 4);
  for (const [network, list] of Object.entries(PREFIXES) as [MobileNetwork, readonly string[]][]) {
    if (list.includes(prefix)) return network;
  }
  return null;
}

// A network can sell more than one VTpass data service — Glo has "glo-data" and "glo-sme-data"
// (Best Value), 9mobile has "etisalat-data" and "9mobile-sme-data". [0] is the default a fresh
// detection lands on; the rest stay selectable without being treated as "not this network".
// 9mobile's second entry keeps the "9mobile-" prefix VTpass actually uses.
export const NETWORK_DATA_SERVICES: Record<MobileNetwork, string[]> = {
  mtn: ['mtn-data'],
  airtel: ['airtel-data'],
  glo: ['glo-data', 'glo-sme-data'],
  etisalat: ['etisalat-data', '9mobile-sme-data'],
};

/** Display names for the detected-network hint. */
export const NETWORK_LABEL: Record<MobileNetwork, string> = { mtn: 'MTN', airtel: 'Airtel', glo: 'Glo', etisalat: '9mobile' };
