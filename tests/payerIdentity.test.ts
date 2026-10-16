import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// 🤖 Which agent is paying (src/lib/payerIdentity.ts): ERC-8004 identities confirmed against the
// registry, Self Agent ID status, and the cache. Admin-only data, so the point of these tests is
// that what the dashboard calls a fact is one the chain confirmed.

vi.mock('server-only', () => ({}));

const WALLET = '0x178977e82c4df50d5a7465f4495170dff9275363';
const OTHER = '0x2222222222222222222222222222222222222222';
const REGISTRY = '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432';
const SELF = '0xac3df9abf80d0f5c020c06b04cced27763355944';

let db: FakeDb;
let owners: Record<string, string> = {};
let agentWallets: Record<string, string> = {};
let tokenUris: Record<string, string> = {};
let self = { verified: false as boolean | Error, id: BigInt(0), human: true, fresh: true };
let logIds: bigint[] | Error = [];
let blockscout: { items: unknown[] } | Error = { items: [] };
const reads: string[] = [];

vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/chain', () => ({
  isMainnetEnv: () => true,
  getPublicClient: () => ({
    readContract: async ({ address, functionName, args }: { address: string; functionName: string; args: unknown[] }) => {
      reads.push(functionName);
      const a = address.toLowerCase();
      if (a === SELF) {
        if (self.verified instanceof Error) throw self.verified;
        if (functionName === 'isVerifiedAgent') return self.verified;
        if (functionName === 'getAgentId') return self.id;
        if (functionName === 'hasHumanProof') return self.human;
        if (functionName === 'isProofFresh') return self.fresh;
      }
      if (a === REGISTRY) {
        const id = String(args[0]);
        if (functionName === 'ownerOf') { if (!owners[id]) throw new Error('ERC721NonexistentToken'); return owners[id]; }
        if (functionName === 'getAgentWallet') return agentWallets[id] ?? '0x0000000000000000000000000000000000000000';
        if (functionName === 'tokenURI') return tokenUris[id] ?? '';
      }
      throw new Error(`unmodelled ${functionName}`);
    },
    getLogs: async () => { if (logIds instanceof Error) throw logIds; return logIds.map((tokenId) => ({ args: { tokenId } })); },
  }),
}));
vi.stubGlobal('fetch', async (url: string) => {
  if (String(url).includes('blockscout.com')) {
    if (blockscout instanceof Error) throw blockscout;
    return new Response(JSON.stringify(blockscout));
  }
  throw new Error(`unexpected fetch ${url}`);
});

const { lookupPayerIdentity, refreshPayerIdentity, agentFieldsFromMetadata, clientInfoFromRequest } = await import('@/lib/payerIdentity');

const EARMARK_META = {
  name: 'Earmark', active: true, type: 'Agent',
  description: 'Earmark pools a group obligation from a family or house chat.',
  endpoints: [
    { type: 'web', url: 'https://earmark-agent.onrender.com' },
    { type: 'x402', url: 'https://earmark-agent.onrender.com/x402' },
    { type: 'wallet', address: WALLET, chainId: 42220 },
  ],
};
const nft = (id: string, metadata: unknown = EARMARK_META, token = REGISTRY) => ({ id, metadata, token: { address_hash: token } });

beforeEach(() => {
  db = createFakeDb();
  owners = {}; agentWallets = {}; tokenUris = {};
  self = { verified: false, id: BigInt(0), human: true, fresh: true };
  logIds = []; blockscout = { items: [] };
  reads.length = 0;
});

describe('lookupPayerIdentity — ERC-8004', () => {
  it('lists an agent the wallet owns, confirmed by ownerOf, with its registered name and endpoints', async () => {
    blockscout = { items: [nft('9806'), nft('1', {}, '0x9999999999999999999999999999999999999999')] };
    owners['9806'] = WALLET;
    const id = await lookupPayerIdentity(WALLET);
    expect(id.erc8004_agents).toEqual([{
      id: '9806', relation: 'owner', name: 'Earmark', active: true,
      description: 'Earmark pools a group obligation from a family or house chat.',
      web: 'https://earmark-agent.onrender.com', x402: 'https://earmark-agent.onrender.com/x402', image: undefined,
    }]);
    expect(id.self_verified).toBe(false);
    expect(id.lookup_error).toBeNull();
  });

  it('drops an id the indexer reports but the registry says belongs to someone else', async () => {
    blockscout = { items: [nft('9806')] };
    owners['9806'] = OTHER;
    expect((await lookupPayerIdentity(WALLET)).erc8004_agents).toEqual([]);
  });

  it('falls back to the registry log on our RPC when Blockscout is down, reading a data: tokenURI locally', async () => {
    blockscout = new Error('ECONNRESET');
    logIds = [BigInt(42)];
    owners['42'] = WALLET;
    tokenUris['42'] = `data:application/json;base64,${Buffer.from(JSON.stringify({ name: 'LogAgent' })).toString('base64')}`;
    const id = await lookupPayerIdentity(WALLET);
    expect(id.erc8004_agents).toMatchObject([{ id: '42', relation: 'owner', name: 'LogAgent' }]);
  });

  it('never fetches an https tokenURI (agent-controlled URL)', async () => {
    blockscout = { items: [nft('7', null)] };
    owners['7'] = WALLET;
    tokenUris['7'] = 'https://evil.example/meta.json';
    const id = await lookupPayerIdentity(WALLET);
    expect(id.erc8004_agents).toMatchObject([{ id: '7', relation: 'owner' }]);
    expect(id.erc8004_agents[0].name).toBeUndefined();
  });

  it('counts a declared agent id when the registry names this wallet as its agent wallet', async () => {
    owners['55'] = OTHER;
    agentWallets['55'] = WALLET;
    const id = await lookupPayerIdentity(WALLET, { declaredAgentId: '55' });
    expect(id.erc8004_agents).toMatchObject([{ id: '55', relation: 'agent_wallet' }]);
  });

  it('ignores a declared id that is neither owned by nor pointing at the wallet', async () => {
    owners['55'] = OTHER;
    expect((await lookupPayerIdentity(WALLET, { declaredAgentId: '55' })).erc8004_agents).toEqual([]);
  });

  it('records a partial lookup instead of failing when both id sources are down', async () => {
    blockscout = new Error('down');
    logIds = new Error('range too large');
    const id = await lookupPayerIdentity(WALLET);
    expect(id.erc8004_agents).toEqual([]);
    expect(id.lookup_error).toMatch(/erc8004 ids: range too large/);
  });
});

describe('lookupPayerIdentity — Self Agent ID', () => {
  it('reports a verified agent with a fresh human proof', async () => {
    self = { verified: true, id: BigInt(12), human: true, fresh: true };
    expect(await lookupPayerIdentity(WALLET)).toMatchObject({ self_verified: true, self_agent_id: '12', self_human_proof: true, self_proof_fresh: true });
  });

  it('reports an expired proof', async () => {
    self = { verified: true, id: BigInt(12), human: true, fresh: false };
    expect((await lookupPayerIdentity(WALLET)).self_proof_fresh).toBe(false);
  });

  it('leaves Self unknown (null), not "not verified", when the registry cannot be read', async () => {
    self.verified = new Error('rpc down');
    const id = await lookupPayerIdentity(WALLET);
    expect(id.self_verified).toBeNull();
    expect(id.lookup_error).toMatch(/self: rpc down/);
  });
});

describe('refreshPayerIdentity — cache', () => {
  it('looks a wallet up once a day, and again when a request declares an agent id it has not seen', async () => {
    blockscout = { items: [nft('9806')] };
    owners['9806'] = WALLET;
    await refreshPayerIdentity(WALLET);
    expect(db.tables.payer_identities).toHaveLength(1);

    reads.length = 0;
    await refreshPayerIdentity(WALLET, { declaredAgentId: '9806' });
    expect(reads).toHaveLength(0); // cached, and the cache already covers #9806

    await refreshPayerIdentity(WALLET, { declaredAgentId: '77' });
    expect(reads.length).toBeGreaterThan(0);

    reads.length = 0;
    await refreshPayerIdentity(WALLET, { now: Date.now() + 25 * 60 * 60 * 1000 });
    expect(reads.length).toBeGreaterThan(0);
  });

  it('ignores something that is not an address', async () => {
    expect(await refreshPayerIdentity('not-a-wallet')).toBeNull();
    expect(db.tables.payer_identities ?? []).toHaveLength(0);
  });
});

describe('untrusted input', () => {
  it('keeps only http(s) links and clips long fields from agent metadata', () => {
    const f = agentFieldsFromMetadata({
      name: 'x'.repeat(500), image: 'javascript:alert(1)',
      services: [{ name: 'web', endpoint: 'javascript:alert(1)' }, { name: 'x402', endpoint: 'https://a.example/x402' }],
    });
    expect(f.name).toHaveLength(80);
    expect(f.image).toBeUndefined();
    expect(f.web).toBeUndefined();
    expect(f.x402).toBe('https://a.example/x402');
  });

  it('reads the client headers, accepting only a numeric declared agent id', () => {
    const req = new Request('http://localhost', { headers: { 'user-agent': 'earmark/1.0 x402-fetch', 'x-agent-name': 'Earmark', 'x-agent-id': '9806' } });
    expect(clientInfoFromRequest(req, { sdk: 'x402-fetch' })).toEqual({ user_agent: 'earmark/1.0 x402-fetch', declared_agent: 'Earmark', declared_agent_id: '9806', client_diag: { sdk: 'x402-fetch' } });
    const bad = new Request('http://localhost', { headers: { 'x-agent-id': '9806; drop table' } });
    expect(clientInfoFromRequest(bad).declared_agent_id).toBeNull();
  });
});
