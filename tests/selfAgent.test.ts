import { describe, it, expect, vi, beforeEach } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

// Self Agent ID on AbaPay's MCP/x402 requests (src/lib/selfAgent.ts): real secp256k1 signatures
// over the protocol's digest, the SelfAgentRegistry stubbed. Policy under test: no headers →
// unchanged; a signature that doesn't check out → refused; a valid signature → shown with its
// registry status (verified / expired / not registered / …), never blocking a payment.

vi.mock('server-only', () => ({}));

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const agent = privateKeyToAccount(KEY);

let reg: { verified: boolean; id: bigint; human: boolean; fresh: boolean; provider: string; selfProvider: string } | Error;
vi.mock('@/lib/chain', () => ({
  isMainnetEnv: () => true,
  getPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (reg instanceof Error) throw reg;
      switch (functionName) {
        case 'isVerifiedAgent': return reg.verified;
        case 'getAgentId': return reg.id;
        case 'hasHumanProof': return reg.human;
        case 'isProofFresh': return reg.fresh;
        case 'getProofProvider': return reg.provider;
        case 'selfProofProvider': return reg.selfProvider;
      }
      throw new Error(functionName);
    },
  }),
}));

const { verifySelfAgentRequest, selfSigningDigest, withSelfAgent } = await import('@/lib/selfAgent');

const PROVIDER = '0x1111111111111111111111111111111111111111';
const URL_ = 'https://agents.abapays.com/api/pay/x402?x=1';
const BODY = JSON.stringify({ serviceID: 'mtn', billersCode: '08012345678', amount: 100 });

let tsCounter = 0;
async function signed(opts: { body?: string; signBody?: string; ts?: number; address?: string; method?: string } = {}) {
  const ts = String(opts.ts ?? Date.now() - (tsCounter++)); // distinct signatures (replay cache)
  const digest = selfSigningDigest(ts, opts.method ?? 'POST', URL_, opts.signBody ?? opts.body ?? BODY);
  const signature = await agent.signMessage({ message: { raw: digest } });
  const req = new Request(URL_, {
    method: opts.method ?? 'POST',
    headers: { 'content-type': 'application/json', 'x-self-agent-address': opts.address ?? agent.address, 'x-self-agent-signature': signature, 'x-self-agent-timestamp': ts },
    body: opts.body ?? BODY,
  });
  return { req, raw: opts.body ?? BODY, signature, ts };
}

beforeEach(() => {
  reg = { verified: true, id: BigInt(42), human: true, fresh: true, provider: PROVIDER, selfProvider: PROVIDER };
});

describe('verifySelfAgentRequest', () => {
  it('no Self headers → not present (nothing changes)', async () => {
    expect(await verifySelfAgentRequest(new Request(URL_, { method: 'POST', body: BODY }), BODY)).toEqual({ present: false });
  });

  it('a verified agent with a fresh human proof from Self → verified, with its agent id', async () => {
    const { req, raw } = await signed();
    expect(await verifySelfAgentRequest(req, raw)).toEqual({ present: true, status: 'verified', agentAddress: agent.address, agentId: '42' });
  });

  it.each([
    ['expired proof', { fresh: false }, 'expired'],
    ['revoked (registered, no longer verified)', { verified: false }, 'not_registered'],
    ['never registered', { verified: false, id: BigInt(0) }, 'not_registered'],
    ['no human proof', { human: false }, 'no_human_proof'],
    ['proof from another provider', { provider: '0x2222222222222222222222222222222222222222' }, 'wrong_provider'],
  ])('%s → %s (still allowed to pay)', async (_l, over, status) => {
    reg = { ...(reg as object), ...over } as typeof reg;
    const { req, raw } = await signed();
    expect(await verifySelfAgentRequest(req, raw)).toMatchObject({ present: true, status, agentAddress: agent.address });
  });

  it('a registry that cannot be read → unavailable, never invalid', async () => {
    reg = new Error('rpc down');
    const { req, raw } = await signed();
    expect(await verifySelfAgentRequest(req, raw)).toMatchObject({ present: true, status: 'unavailable' });
  });

  it.each([
    ['a body different from the one signed', { signBody: '{"amount":1}' }],
    ['a stale timestamp', { ts: Date.now() - 10 * 60_000 }],
    ['a different claimed address', { address: '0x3333333333333333333333333333333333333333' }],
  ])('%s → invalid', async (_l, opts) => {
    const { req, raw } = await signed(opts);
    expect(await verifySelfAgentRequest(req, raw)).toMatchObject({ present: true, status: 'invalid' });
  });

  it('a replayed signature → invalid', async () => {
    const first = await signed();
    expect(await verifySelfAgentRequest(first.req, first.raw)).toMatchObject({ status: 'verified' });
    const again = new Request(URL_, { method: 'POST', headers: first.req.headers, body: BODY });
    expect(await verifySelfAgentRequest(again, BODY)).toMatchObject({ status: 'invalid', detail: expect.stringMatching(/already used/) });
  });

  it('incomplete headers → invalid', async () => {
    const req = new Request(URL_, { method: 'POST', headers: { 'x-self-agent-address': agent.address }, body: BODY });
    expect(await verifySelfAgentRequest(req, BODY)).toMatchObject({ status: 'invalid' });
  });
});

describe('withSelfAgent', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const refuse = (detail: string) => json({ errorCode: 'SELF_AGENT_INVALID', error: detail }, 401);

  it('passes a request without Self headers through untouched', async () => {
    const handler = vi.fn(async () => json({ success: true }));
    const res = await withSelfAgent(new Request(URL_, { method: 'POST', body: BODY }), handler, refuse);
    expect(handler).toHaveBeenCalled();
    expect(res.headers.get('x-abapay-self-agent')).toBeNull();
    expect(await res.json()).toEqual({ success: true });
  });

  it('refuses a forged signature before the handler runs (nothing priced or settled)', async () => {
    const handler = vi.fn(async () => json({ success: true }));
    const { req } = await signed({ signBody: '{"other":true}' });
    const res = await withSelfAgent(req, handler, refuse);
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('shows a verified agent as verified: header and self_agent on the JSON', async () => {
    const { req } = await signed();
    const res = await withSelfAgent(req, async () => json({ success: true, status: 'SUCCESS' }), refuse);
    expect(res.headers.get('x-abapay-self-agent')).toBe('verified; agent_id=42');
    expect(await res.json()).toMatchObject({ success: true, self_agent: { status: 'verified', agent_id: '42', agent_address: agent.address } });
  });

  it('puts it on result._meta for a JSON-RPC (MCP/A2A) reply', async () => {
    const { req } = await signed();
    const res = await withSelfAgent(req, async () => json({ jsonrpc: '2.0', id: 1, result: { content: [] } }), refuse);
    expect(await res.json()).toMatchObject({ result: { _meta: { 'abapay/self_agent': { status: 'verified', agent_id: '42' } } } });
  });

  it('lets the handler read the body after verification', async () => {
    const { req } = await signed();
    const res = await withSelfAgent(req, async (r) => json({ echoed: await r.json() }), refuse);
    expect((await res.json()).echoed).toEqual(JSON.parse(BODY));
  });
});

describe('abapay-sdk interop', () => {
  it('headers made by the published SDK (sdk/src/selfAgent.ts) verify here', async () => {
    const { selfAgentHeaders } = await import('../sdk/src/selfAgent');
    const headers = await selfAgentHeaders(agent, { method: 'POST', url: URL_, body: BODY });
    const req = new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: BODY });
    expect(await verifySelfAgentRequest(req, BODY)).toMatchObject({ present: true, status: 'verified', agentId: '42' });
  });
});
