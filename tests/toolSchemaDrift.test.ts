import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

// 🔴 ONE TOOL CONTRACT, THREE COPIES — AND THIS IS WHAT KEEPS THEM HONEST (M4.7).
//
// The real MCP tool catalog is TOOLS in src/lib/deai/mcpTools.ts (served by /api/mcp and A2A).
// Two copies exist on purpose:
//   • src/app/agents/toolSchemas.ts — the /agents docs site, with curated wording and
//     Celo-only enums for that audience;
//   • mcp-server/server.js — the dependency-free gateway Glama boots with no network.
// Neither can import mcpTools.ts, so they are copies. Copies drift: adding get_payment_status
// left the gateway with a syntax error nothing caught. This test fails the build when a copy
// disagrees with the real catalog on anything a client depends on — tool names, parameter
// names, which are required, and allowed values — while leaving their prose alone.

vi.mock('server-only', () => ({}));

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://example.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

type Schema = { properties?: Record<string, { enum?: string[] }>; required?: string[] };
const props = (s: Schema) => Object.keys(s.properties || {}).sort();
const required = (s: Schema) => [...(s.required || [])].sort();

describe('tool schema copies match the real MCP catalog', async () => {
  const real = (await import('@/lib/deai/mcpTools')).TOOLS as { name: string; inputSchema: Schema }[];
  const docs = (await import('@/app/agents/toolSchemas')).TOOLS;
  // Requiring it also proves the gateway parses (a syntax error there breaks Glama's check).
  const gateway = createRequire(import.meta.url)('../mcp-server/server.js').TOOLS as { name: string; inputSchema: Schema }[];
  const byName = <T extends { name: string }>(xs: T[]) => new Map(xs.map((x) => [x.name, x]));
  const realBy = byName(real);

  it('lists exactly the same tools in all three places', () => {
    const names = real.map((t) => t.name).sort();
    expect(gateway.map((t) => t.name).sort()).toEqual(names);
    expect(docs.map((t) => t.name).sort()).toEqual(names);
  });

  it('the gateway matches parameter names, required fields and enums exactly', () => {
    for (const g of gateway) {
      const r = realBy.get(g.name)!;
      expect({ tool: g.name, props: props(g.inputSchema) }).toEqual({ tool: g.name, props: props(r.inputSchema) });
      expect({ tool: g.name, required: required(g.inputSchema) }).toEqual({ tool: g.name, required: required(r.inputSchema) });
      for (const [p, def] of Object.entries(g.inputSchema.properties || {})) {
        const realEnum = r.inputSchema.properties?.[p]?.enum;
        if (def.enum || realEnum) expect({ tool: g.name, param: p, enum: def.enum }).toEqual({ tool: g.name, param: p, enum: realEnum });
      }
    }
  });

  it('the docs site matches parameter names and required flags; its enums are a subset', () => {
    for (const d of docs) {
      const r = realBy.get(d.name)!;
      expect({ tool: d.name, params: d.params.map((p) => p.name).sort() }).toEqual({ tool: d.name, params: props(r.inputSchema) });
      const realRequired = new Set(r.inputSchema.required || []);
      for (const p of d.params) {
        expect({ tool: d.name, param: p.name, required: p.required }).toEqual({ tool: d.name, param: p.name, required: realRequired.has(p.name) });
        // Celo-only docs may list fewer values, never values the server rejects.
        const realEnum = r.inputSchema.properties?.[p.name]?.enum;
        if (p.enum && realEnum) for (const v of p.enum) expect({ tool: d.name, param: p.name, value: v, ok: realEnum.includes(v) }).toMatchObject({ ok: true });
      }
    }
  });
}, 300_000);
