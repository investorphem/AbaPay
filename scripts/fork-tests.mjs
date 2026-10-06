#!/usr/bin/env node
// 🍴 Runs test/fork against a fork of Celo and of Base (M7 nightly), one Hardhat process per chain
// because the fork and its chain id are fixed for a process.
//
// Endpoints: CELO_FORK_RPC_URL / BASE_FORK_RPC_URL if set (a paid provider: faster, fewer rate
// limits), otherwise the chains' public RPCs. The fork reads state at its block for the whole run,
// so an endpoint needs ARCHIVE access. Both public RPCs have it; free plans of paid providers often
// don't (Chainstack's Developer plan refuses archive reads). A configured endpoint that fails the
// preflight is reported as a warning and the public one is used, so the nightly keeps running.
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local', quiet: true });

const CHAINS = {
  celo: { chainId: 42220, publicRpc: 'https://forno.celo.org' },
  base: { chainId: 8453, publicRpc: 'https://mainnet.base.org' },
};
const envKey = (chain) => `${chain.toUpperCase()}_FORK_RPC_URL`;

// One plain request before Hardhat, so a bad endpoint fails with the provider's own words instead
// of a fork error. Never prints the URL's path: that's where providers put the access key, and
// GitHub masks only the secret as a whole, not pieces of it.
async function preflight(chain, raw) {
  const url = raw.trim();
  let host;
  let pathLen;
  try {
    const u = new URL(url);
    host = u.host;
    pathLen = u.pathname.replace(/^\/+/, '').length;
  } catch {
    return 'not a valid URL (it should be the full https:// endpoint)';
  }
  if (raw !== url) console.log(`::warning::${chain}: the configured URL has leading/trailing whitespace`);
  const call = async (method, params) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return { status: res.status, text: (await res.text()).slice(0, 300) };
  };
  try {
    const id = await call('eth_chainId', []);
    if (id.status !== 200) {
      return `${host} answered HTTP ${id.status}: ${id.text || '(empty body)'} [the URL has ${pathLen} characters after the host; providers usually put the key there]`;
    }
    const got = Number(JSON.parse(id.text).result);
    if (got !== CHAINS[chain].chainId) return `${host} is chain ${got}, expected ${CHAINS[chain].chainId}`;
    const head = Number(JSON.parse((await call('eth_blockNumber', [])).text).result);
    const old = await call('eth_getBalance', [
      '0x0000000000000000000000000000000000000000',
      '0x' + Math.max(1, head - 50_000).toString(16),
    ]);
    if (old.status !== 200 || /"error"/.test(old.text)) {
      return `${host} works but can't serve older state (archive access needed): ${old.text}`;
    }
    console.log(`${chain}: ${host} OK (chain ${got}, archive reads work)`);
    return null;
  } catch (e) {
    return `${host}: ${e.message}`;
  }
}

/** The endpoint to fork from: the configured one if it passes the preflight, else the public one. */
async function endpointFor(chain) {
  const configured = process.env[envKey(chain)];
  if (configured) {
    const problem = await preflight(chain, configured);
    if (!problem) return configured.trim();
    console.log(`::warning::${envKey(chain)} is unusable, falling back to the public RPC. ${problem}`);
  }
  const problem = await preflight(chain, CHAINS[chain].publicRpc);
  if (problem) throw new Error(`public RPC unusable too: ${problem}`);
  return CHAINS[chain].publicRpc;
}

let failed = false;
for (const chain of Object.keys(CHAINS)) {
  console.log(`\n=== Fork tests: ${chain} ===`);
  let url;
  try {
    url = await endpointFor(chain);
  } catch (e) {
    console.error(`::error::${chain} fork RPC: ${e.message}`);
    failed = true;
    continue;
  }
  const r = spawnSync('npx', ['hardhat', 'test', 'test/fork/vaults.fork.ts'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, FORK_CHAIN: chain, [envKey(chain)]: url },
  });
  if (r.status !== 0) {
    console.error(`::error::Fork tests failed on ${chain}.`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
