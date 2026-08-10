import { describe, it, expect, vi } from 'vitest';

// ⚡ AGENT CARD + EXTRACTION SHAPE
//
// Two jobs here.
//
// 1. The A2A agent card is the discovery document a peer agent reads before doing anything else,
//    so a malformed one is silently fatal — nothing errors, peers just never call.
//
// 2. 🔴 THE MERGE GATE: the second block imports the REAL src/lib/deai/mcpTools.ts, unmocked. That
//    module was produced by relocating 873 lines out of src/app/api/mcp/route.ts — the live payment
//    path. tsc proves the types line up; it does NOT prove the module loads or still exports what
//    /api/mcp imports at runtime. If this block fails, /api/mcp is broken in production and the
//    branch must not merge.

vi.mock('server-only', () => ({}));

vi.mock('@/lib/deai/mcpTools', () => ({
  TOOLS: [
    { name: 'describe_capabilities', description: 'List what AbaPay can pay for.\nSecond line ignored.', inputSchema: {} },
    { name: 'check_balance', description: "Check a wallet's balances.", inputSchema: {} },
    { name: 'list_plans', description: 'List purchasable plans.', inputSchema: {} },
    { name: 'list_international_options', description: 'Browse international options.', inputSchema: {} },
    { name: 'transaction_history', description: 'Recent history.', inputSchema: {} },
    { name: 'pay_bill', description: 'Pay a bill.', inputSchema: {} },
  ],
}));

const { GET } = await import('@/app/.well-known/agent-card.json/route');

describe('A2A agent card', () => {
  it('is served as JSON with the required top-level fields', async () => {
    const res = await GET();
    expect(res.status).toBe(200);

    const card = await res.json();
    expect(card.protocolVersion).toBe('0.3.0');
    expect(card.name).toBe('AbaPay');
    expect(card.version).toBeTruthy();
    expect(card.description.length).toBeGreaterThan(50);
    expect(card.preferredTransport).toBe('JSONRPC');
    expect(card.url).toMatch(/\/api\/a2a$/);
  });

  it('declares only capabilities that are actually implemented', async () => {
    const card = await (await GET()).json();
    // Declaring streaming or push we do not implement would strand a peer waiting on updates
    // that never arrive — worse than declaring nothing.
    expect(card.capabilities.streaming).toBe(false);
    expect(card.capabilities.pushNotifications).toBe(false);
    expect(card.capabilities.stateTransitionHistory).toBe(false);
  });

  it('advertises bearer auth, because payments are never anonymous here', async () => {
    const card = await (await GET()).json();
    expect(card.securitySchemes.bearer.type).toBe('http');
    expect(card.securitySchemes.bearer.scheme).toBe('bearer');
    expect(card.security).toEqual([{ bearer: [] }]);
    // The PIN requirement must survive into the public description — a token authenticates the
    // connection, it never authorises a spend.
    expect(card.securitySchemes.bearer.description).toMatch(/PIN/i);
  });

  it('derives skill descriptions from TOOLS so docs cannot drift between protocols', async () => {
    const card = await (await GET()).json();
    expect(card.skills).toHaveLength(6);

    const describe_ = card.skills.find((s: any) => s.id === 'describe_capabilities');
    expect(describe_.description).toBe('List what AbaPay can pay for.'); // first line only
    expect(describe_.description).not.toContain('Second line');

    for (const skill of card.skills) {
      expect(skill.id).toBeTruthy();
      expect(skill.name).toBeTruthy();
      expect(skill.description).not.toBe(skill.id); // never fell back to the bare id
      expect(Array.isArray(skill.tags)).toBe(true);
    }
  });

  it('exposes every skill the A2A endpoint can dispatch', async () => {
    const card = await (await GET()).json();
    const ids = card.skills.map((s: any) => s.id).sort();
    expect(ids).toEqual(
      ['check_balance', 'describe_capabilities', 'list_international_options', 'list_plans', 'pay_bill', 'transaction_history'].sort(),
    );
  });
});

describe('MERGE GATE — the real mcpTools module still loads and exports its contract', () => {
  it('loads unmocked and exposes everything /api/mcp and /api/a2a import from it', async () => {
    // src/utils/supabase.ts calls createClient() at module scope, and vitest does not read
    // .env.local — without these the import dies on "supabaseUrl is required" before it can
    // tell us anything about the extraction. Dummies are correct here: this test asserts the
    // module's export SHAPE, and never issues a query, so no real credentials are wanted.
    process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

    vi.doUnmock('@/lib/deai/mcpTools');
    vi.resetModules();

    const real = await import('@/lib/deai/mcpTools');

    // Exactly the symbols the two route files import. A missing one here means a broken import
    // in production, which tsc alone would not have caught at module-load time.
    expect(typeof real.callTool).toBe('function');
    expect(typeof real.errorResult).toBe('function');
    expect(typeof real.textResult).toBe('function');
    expect(typeof real.NEEDS_AUTH).toBe('symbol');
    expect(typeof real.PROTOCOL_VERSION).toBe('string');
    expect(real.SERVER_INFO.name).toBe('abapay');
    expect(real.WWW_AUTH_MISSING).toContain('resource_metadata');
    expect(real.WWW_AUTH_INVALID).toContain('invalid_token');

    // The tool surface must be intact — the extraction moved these verbatim, so any change in
    // count or naming means content was lost in the move.
    expect(Array.isArray(real.TOOLS)).toBe(true);
    expect(real.TOOLS).toHaveLength(6);
    expect(real.TOOLS.map((t: any) => t.name).sort()).toEqual(
      ['check_balance', 'describe_capabilities', 'list_international_options', 'list_plans', 'pay_bill', 'transaction_history'].sort(),
    );
    for (const tool of real.TOOLS as any[]) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
    }
    // Generous timeout: this is the one test that imports the real module, which pulls in the
    // whole payment dependency tree (supabase, viem, the vend/relayer stack). That took ~97s on
    // the machine this was written on and blew vitest's 5s default — a slow import is not a
    // failing contract, so the timeout is raised rather than the assertion weakened.
  }, 300_000);
});
