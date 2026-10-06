#!/usr/bin/env node
// 🍴 Runs test/fork against a fork of each chain whose RPC URL is set (M7 nightly):
//   CELO_FORK_RPC_URL → FORK_CHAIN=celo,  BASE_FORK_RPC_URL → FORK_CHAIN=base
// One Hardhat process per chain, because the fork and its chain id are fixed for a process.
// The URLs need archive access (state is read at the fork block for the whole run).
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local', quiet: true });

const chains = ['celo', 'base'].filter((c) => process.env[`${c.toUpperCase()}_FORK_RPC_URL`]);
if (chains.length === 0) {
  console.log('::warning::No CELO_FORK_RPC_URL or BASE_FORK_RPC_URL set: fork tests skipped.');
  process.exit(0);
}

const CHAIN_IDS = { celo: 42220, base: 8453 };

// One plain request before Hardhat, so a bad endpoint fails with the provider's own words instead
// of a fork error. Never prints the URL's path: that's where providers put the access key, and
// GitHub masks only the secret as a whole, not pieces of it.
async function preflight(chain) {
  const raw = process.env[`${chain.toUpperCase()}_FORK_RPC_URL`];
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
  if (raw !== url) console.log(`::warning::${chain}: the secret has leading/trailing whitespace`);
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
      return `${host} answered HTTP ${id.status}: ${id.text || '(empty body)'} [the URL has ${pathLen} characters after the host; a Chainstack endpoint carries its key there]`;
    }
    const got = Number(JSON.parse(id.text).result);
    if (got !== CHAIN_IDS[chain]) return `${host} is chain ${got}, expected ${CHAIN_IDS[chain]}`;
    // The fork reads state at its block for the whole run, which needs archive access.
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

let failed = false;
for (const chain of chains) {
  console.log(`\n=== Fork tests: ${chain} ===`);
  const problem = await preflight(chain);
  if (problem) {
    console.error(`::error::${chain} fork RPC: ${problem}`);
    failed = true;
    continue;
  }
  const r = spawnSync('npx', ['hardhat', 'test', 'test/fork/vaults.fork.ts'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, FORK_CHAIN: chain },
  });
  if (r.status !== 0) {
    console.error(`::error::Fork tests failed on ${chain}.`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
