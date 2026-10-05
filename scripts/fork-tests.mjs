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

let failed = false;
for (const chain of chains) {
  console.log(`\n=== Fork tests: ${chain} ===`);
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
