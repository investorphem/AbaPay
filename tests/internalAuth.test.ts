import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

// The internal token is derived from env at call time, so we reset the module
// registry between cases to pick up env changes cleanly.
async function loadModule() {
  vi.resetModules();
  return await import('@/utils/internalAuth');
}

function reqWith(headers: Record<string, string>) {
  return new Request('https://example.com/api/deai/core', { method: 'POST', headers });
}

describe('internalAuth', () => {
  beforeEach(() => {
    process.env.DEAI_INTERNAL_SECRET = 'test-secret-value';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('accepts a request carrying the correct internal token', async () => {
    const { getInternalToken, verifyInternalRequest } = await loadModule();
    const token = getInternalToken()!;
    expect(verifyInternalRequest(reqWith({ 'x-abapay-internal': token }))).toBe(true);
  });

  it('rejects a request with NO internal header (the public-internet attack)', async () => {
    // This is exactly what we're defending: anyone POSTing directly to /api/deai/core
    // with a victim's chat ID must be turned away.
    const { verifyInternalRequest } = await loadModule();
    expect(verifyInternalRequest(reqWith({}))).toBe(false);
  });

  it('rejects a request with a wrong token', async () => {
    const { verifyInternalRequest } = await loadModule();
    expect(verifyInternalRequest(reqWith({ 'x-abapay-internal': 'not-the-token' }))).toBe(false);
  });

  it('never exposes the raw secret in the token (it is a sha256 hash)', async () => {
    const { getInternalToken } = await loadModule();
    const token = getInternalToken()!;
    expect(token).not.toContain('test-secret-value');
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic for the same secret (so webhook and core agree)', async () => {
    const { getInternalToken } = await loadModule();
    expect(getInternalToken()).toEqual(getInternalToken());
  });

  it('FAILS CLOSED when no secret material is configured at all', async () => {
    // A misconfigured server must reject everything, never allow-all.
    delete process.env.DEAI_INTERNAL_SECRET;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { verifyInternalRequest } = await loadModule();
    expect(verifyInternalRequest(reqWith({ 'x-abapay-internal': 'anything' }))).toBe(false);
  });

  it('round-trips: internalAuthHeaders() produces a header the verifier accepts', async () => {
    const { internalAuthHeaders, verifyInternalRequest } = await loadModule();
    const headers = internalAuthHeaders() as Record<string, string>;
    expect(verifyInternalRequest(reqWith(headers))).toBe(true);
  });
});
