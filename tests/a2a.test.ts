import { describe, it, expect, vi, beforeEach } from 'vitest';

// ⚡ A2A TRANSPORT TESTS
//
// These cover the code added for /api/a2a — JSON-RPC framing, part mapping, the auth branch and
// the error codes. The TOOLS themselves are deliberately mocked: they were moved verbatim out of
// the MCP route into src/lib/deai/mcpTools.ts and are exercised in production by /api/mcp, so what
// needs proving here is the new transport, not the payment logic underneath it.
//
// 🔴 THE ONE RULE THESE ENFORCE: A2A must reach money only through callTool(). If a future change
// lets this route touch a wallet directly, the "same trust boundary, new transport" claim in the
// route header stops being true — and the assertion that check_balance 401s without a credential
// is what catches that.

vi.mock('server-only', () => ({}));

const callTool = vi.fn();
let channelEnabled = true;
let identityResult: unknown = null;

const NEEDS_AUTH = Symbol('mcp-needs-auth');

const TOOLS = [
  { name: 'describe_capabilities', description: 'List what AbaPay can pay.', inputSchema: { type: 'object', properties: {} } },
  { name: 'check_balance', description: "Check a wallet's balances.", inputSchema: { type: 'object', properties: {} } },
  { name: 'list_plans', description: 'List purchasable plans.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_international_options', description: 'Browse international options.', inputSchema: { type: 'object', properties: {} } },
  { name: 'transaction_history', description: 'Recent history.', inputSchema: { type: 'object', properties: {} } },
  { name: 'pay_bill', description: 'Pay a bill.', inputSchema: { type: 'object', properties: {} } },
];

vi.mock('@/lib/deai/mcpTools', () => ({
  TOOLS,
  NEEDS_AUTH,
  WWW_AUTH_MISSING: 'Bearer resource_metadata="https://abapays.com/.well-known/oauth-protected-resource"',
  WWW_AUTH_INVALID: 'Bearer error="invalid_token"',
  callTool: (...args: unknown[]) => callTool(...args),
}));

vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: async () => null }));
vi.mock('@/lib/serviceRules', () => ({ isChannelEnabled: async () => channelEnabled }));
vi.mock('@/lib/deai/mcpAuth', () => ({ resolveMcpIdentity: async () => identityResult }));
vi.mock('@/lib/deai/mcpOAuth', () => ({ validateAccessToken: async () => identityResult }));

const { POST, GET } = await import('@/app/api/a2a/route');

const rpc = (method: string, params?: unknown, id: unknown = 1) =>
  new Request('http://localhost/api/a2a', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });

const message = (parts: unknown[]) => ({ message: { kind: 'message', role: 'user', messageId: 'm1', parts } });
const textPart = (text: string) => ({ kind: 'text', text });
const dataPart = (skill: string, args: unknown = {}) => ({ kind: 'data', data: { skill, args } });

beforeEach(() => {
  callTool.mockReset();
  channelEnabled = true;
  identityResult = null;
});

describe('GET /api/a2a', () => {
  it('advertises the protocol and points at the agent card', async () => {
    const body = await (await GET()).json();
    expect(body.protocol).toBe('a2a');
    expect(body.protocolVersion).toBe('0.3.0');
    expect(body.transport).toBe('JSONRPC');
    expect(body.agentCard).toMatch(/\/\.well-known\/agent-card\.json$/);
    expect(body.skills).toHaveLength(6);
  });
});

describe('message/send — structured invocation', () => {
  it('dispatches a DataPart skill through callTool and maps the result to parts', async () => {
    callTool.mockResolvedValue({ content: [{ type: 'text', text: 'AbaPay pays airtime and electricity.' }] });

    const res = await POST(rpc('message/send', message([dataPart('describe_capabilities')])));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(callTool).toHaveBeenCalledWith('describe_capabilities', {}, null);
    expect(body.result.kind).toBe('message');
    expect(body.result.role).toBe('agent');

    const text = body.result.parts.find((p: any) => p.kind === 'text');
    expect(text.text).toContain('airtime');

    // The raw tool result rides along so a peer agent can act on structure, not prose.
    const data = body.result.parts.find((p: any) => p.kind === 'data');
    expect(data.data.isError).toBe(false);
    expect(data.data.raw).toBeTruthy();
  });

  it('maps an MCP image block to an A2A FilePart', async () => {
    callTool.mockResolvedValue({
      content: [
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        { type: 'text', text: 'Receipt' },
      ],
    });

    const body = await (await POST(rpc('message/send', message([dataPart('pay_bill')])))).json();
    const file = body.result.parts.find((p: any) => p.kind === 'file');

    expect(file.file.mimeType).toBe('image/png');
    expect(file.file.bytes).toBe('aGVsbG8=');
  });

  it('flags an errored tool result without turning it into a transport error', async () => {
    callTool.mockResolvedValue({ content: [{ type: 'text', text: 'Wrong PIN.' }], isError: true });

    const res = await POST(rpc('message/send', message([dataPart('pay_bill')])));
    const body = await res.json();

    expect(res.status).toBe(200); // a refused payment is a normal answer, not a broken call
    expect(body.error).toBeUndefined();
    expect(body.result.parts.find((p: any) => p.kind === 'data').data.isError).toBe(true);
  });

  it('echoes contextId back to the caller', async () => {
    callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const params = { message: { kind: 'message', role: 'user', messageId: 'm1', contextId: 'ctx-42', parts: [dataPart('describe_capabilities')] } };
    const body = await (await POST(rpc('message/send', params))).json();
    expect(body.result.contextId).toBe('ctx-42');
  });
});

describe('message/send — prose gets the catalogue, never a guess', () => {
  it('returns the skill catalogue for a text part and never calls a tool', async () => {
    const res = await POST(rpc('message/send', message([textPart('please send 5000 airtime to 08012345678')])));
    const body = await res.json();

    // The whole point: a payment agent must not infer an invocation from free text.
    expect(callTool).not.toHaveBeenCalled();
    expect(res.status).toBe(200);

    const data = body.result.parts.find((p: any) => p.kind === 'data');
    expect(data.data.skills).toHaveLength(6);
    expect(data.data.skills[0].inputSchema).toBeTruthy();
  });
});

describe('authorization', () => {
  it('401s with WWW-Authenticate when a tool needs a credential and none was offered', async () => {
    callTool.mockResolvedValue(NEEDS_AUTH);

    const res = await POST(rpc('message/send', message([dataPart('check_balance')])));

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata');
  });

  it('401s when a credential is offered but does not resolve', async () => {
    identityResult = null; // resolver returns nothing for the supplied token
    const req = new Request('http://localhost/api/a2a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer aba_mcp_deadbeef' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: message([textPart('hi')]) }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('passes a resolved identity through to callTool', async () => {
    identityResult = { id: 'link-1', wallet_address: '0xabc' };
    callTool.mockResolvedValue({ content: [{ type: 'text', text: 'balance' }] });

    const req = new Request('http://localhost/api/a2a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer aba_mcp_realkey' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: message([dataPart('check_balance')]) }),
    });

    await POST(req);
    expect(callTool).toHaveBeenCalledWith('check_balance', {}, identityResult);
  });
});

describe('operator kill switch', () => {
  it('returns an in-band paused message rather than a transport failure', async () => {
    channelEnabled = false;

    const res = await POST(rpc('message/send', message([dataPart('pay_bill')])));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(callTool).not.toHaveBeenCalled();
    expect(body.result.parts[0].text).toMatch(/paused/i);
  });
});

describe('JSON-RPC error codes', () => {
  it('-32602 for an unknown skill', async () => {
    const body = await (await POST(rpc('message/send', message([dataPart('not_a_skill')])))).json();
    expect(body.error.code).toBe(-32602);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('-32602 when message.parts is missing', async () => {
    const body = await (await POST(rpc('message/send', { message: { kind: 'message', role: 'user' } }))).json();
    expect(body.error.code).toBe(-32602);
  });

  it('-32700 for malformed JSON', async () => {
    const req = new Request('http://localhost/api/a2a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const body = await (await POST(req)).json();
    expect(body.error.code).toBe(-32700);
  });

  it('-32601 for an unknown method', async () => {
    const body = await (await POST(rpc('nonsense/method', {}))).json();
    expect(body.error.code).toBe(-32601);
  });

  it.each(['message/stream', 'tasks/get', 'tasks/cancel', 'tasks/resubscribe', 'tasks/pushNotificationConfig/set'])(
    '-32004 for %s, which the agent card declares unsupported',
    async (method) => {
      const body = await (await POST(rpc(method, {}))).json();
      expect(body.error.code).toBe(-32004);
      expect(body.error.message).toMatch(/synchronously/i);
    },
  );

  it('-32600 when method is absent', async () => {
    const req = new Request('http://localhost/api/a2a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1 }),
    });
    const body = await (await POST(req)).json();
    expect(body.error.code).toBe(-32600);
  });
});
