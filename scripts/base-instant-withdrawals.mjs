#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Make AbaPayV4 withdrawals instant on Base, and clear a stuck queued withdrawal.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   node scripts/base-instant-withdrawals.mjs              show state, change nothing
 *   node scripts/base-instant-withdrawals.mjs --apply      setWithdrawalDelay(0) + cancel
 *   node scripts/base-instant-withdrawals.mjs --apply --withdraw
 *                                                          …and re-queue + execute it now
 *   node scripts/base-instant-withdrawals.mjs --restore-delay 86400
 *                                                          put the 24h timelock back
 *
 * 🔴 WHAT "REMOVE THE WITHDRAWAL QUEUE" CAN AND CANNOT MEAN
 * --------------------------------------------------------
 * The queue is compiled into the deployed bytecode and cannot be removed — a deployed
 * contract's code is immutable, and `withdraw()` simply does not exist on V4. What V4
 * *does* give you is `setWithdrawalDelay(n)`: set it to 0 and the wait disappears, so a
 * withdrawal is queue-then-execute back to back instead of queue-then-wait-24h-execute.
 * Two transactions, no waiting. That is as close to instant as this contract gets, and
 * it is exactly what V4 was written for (see the NatSpec on AbaPayV4.sol).
 *
 * ⚠️ Changing the delay does NOT retroactively free an ALREADY-queued withdrawal — its
 * `executableAt` was stamped at queue time. That is why `--apply` also cancels the
 * pending one: cancel + re-queue under the new 0 delay is the only way to unstick it.
 * Cancelling does not move money; the tokens never left the vault.
 *
 * ⚠️ SECURITY, SAID ONCE AND PLAINLY: the timelock exists so that a stolen owner key
 * cannot drain the vault before anyone notices — it buys detection time. At delay 0 that
 * protection is gone: whoever holds the key can queue and execute in the same minute.
 * Raise it back with --restore-delay once you no longer need same-day access.
 */

import { createPublicClient, createWalletClient, http, formatUnits, formatEther } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const V4 = '0xC0A4dAA04DEd9c54D1239507B5A5E645761ef488';
const TOKENS = {
  USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  USDT: { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
};

const ABI = [
  { inputs: [], name: 'owner', outputs: [{ type: 'address' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'withdrawalDelay', outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
  {
    inputs: [{ type: 'address' }], name: 'pendingWithdrawals',
    outputs: [{ name: 'amount', type: 'uint256' }, { name: 'executableAt', type: 'uint256' }, { name: 'destination', type: 'address' }],
    stateMutability: 'view', type: 'function',
  },
  { inputs: [{ name: 'newDelay', type: 'uint256' }], name: 'setWithdrawalDelay', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [{ name: 'tokenAddress', type: 'address' }], name: 'cancelWithdrawal', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  {
    inputs: [{ name: 'tokenAddress', type: 'address' }, { name: 'destination', type: 'address' }, { name: 'amount', type: 'uint256' }],
    name: 'queueWithdrawal', outputs: [], stateMutability: 'nonpayable', type: 'function',
  },
  { inputs: [{ name: 'tokenAddress', type: 'address' }], name: 'executeWithdrawal', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [{ type: 'address' }], name: 'balanceOf', outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
];

/**
 * Poll `eth_getTransactionReceipt` across every configured RPC until one answers.
 *
 * 🔴 NOT a style preference. Two separate failure modes made the obvious version wrong:
 *
 *   1. viem's waitForTransactionReceipt also walks blocks to detect replacement (speed-up /
 *      cancel) transactions, and the public Base RPCs reject some of those calls outright.
 *   2. base-rpc.publicnode.com rejects eth_getTransactionReceipt itself.
 *
 * Both threw *after* the transaction had been broadcast and mined, so the script reported
 * failure on a success — the worst possible way to be wrong about a transaction, and it
 * invites re-running a state-changing call that already went through. Asking several
 * endpoints and only trusting a real answer is what makes this honest.
 */
async function waitForReceipt(hash, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    for (const client of readClients) {
      try {
        const rc = await client.getTransactionReceipt({ hash });
        if (rc) return rc;
      } catch (err) {
        // TransactionReceiptNotFoundError = mined-not-yet, the normal case while waiting.
        // Anything else means this endpoint cannot answer; try the next one.
        lastError = err;
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(
    `Timed out waiting for the receipt of ${hash}. The transaction was broadcast and may well ` +
      `have succeeded — check https://basescan.org/tx/${hash} BEFORE re-running, so a call that ` +
      `already landed is not sent twice.` +
      (lastError ? `\n  last RPC error: ${String(lastError.shortMessage || lastError.message).split('\n')[0]}` : '')
  );
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const WITHDRAW = args.includes('--withdraw');
const restoreIdx = args.indexOf('--restore-delay');
const RESTORE = restoreIdx === -1 ? null : BigInt(args[restoreIdx + 1]);

// Public Base RPCs. Deliberately not the app's paymaster/bundler URL — these are plain
// owner-signed calls, nothing sponsored, and they must work with no CDP credentials.
//
// 🔴 MORE THAN ONE ENDPOINT ON PURPOSE: public RPCs do not implement the same method set.
// base-rpc.publicnode.com serves reads and accepts sends but rejects eth_getTransactionReceipt
// with "Invalid parameters were provided to the RPC method" — so a script using it alone
// broadcasts fine and is then unable to read back its own result. mainnet.base.org answers
// receipts but rate-limits reads harder. Neither is reliable alone; together they are.
const RPC_URLS = [
  ...(process.env.BASE_RPC_URL ? [process.env.BASE_RPC_URL] : []),
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
];

const clientFor = (url) =>
  createPublicClient({ chain: base, transport: http(url, { retryCount: 3, retryDelay: 2000 }) });

const readClients = RPC_URLS.map(clientFor);
const transport = http(RPC_URLS[0], { retryCount: 5, retryDelay: 2000 });
const pub = createPublicClient({ chain: base, transport });

async function main() {
  const dotenv = await import('dotenv');
  for (const f of ['.env.local', '.env']) {
    const p = join(REPO, f);
    if (existsSync(p)) dotenv.config({ path: p, override: false, quiet: true });
  }

  // The V4 owner on Base is the same EOA the Celo key controls, which is why that
  // variable is accepted here despite the Celo-sounding name.
  const raw = process.env.OWNER_PRIVATE_KEY || process.env.CELO_PRIVATE_KEY;
  if (!raw) {
    console.error('✗ Set OWNER_PRIVATE_KEY (or CELO_PRIVATE_KEY) in .env.local — the AbaPayV4 owner key.');
    process.exit(1);
  }
  const account = privateKeyToAccount(raw.startsWith('0x') ? raw : `0x${raw}`);
  const wallet = createWalletClient({ account, chain: base, transport });

  // Same reason as waitForReceipt: mainnet.base.org rate-limits reads and publicnode is
  // fine with them, so a single-endpoint read fails intermittently for no good reason.
  // Rotate until one answers; only give up when they all refuse.
  const read = async (functionName, args_ = [], address = V4) => {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const client of readClients) {
        try {
          return await client.readContract({ address, abi: ABI, functionName, args: args_ });
        } catch (err) {
          // A revert is a real answer about contract state, not an endpoint problem —
          // retrying it on another RPC would just return the same revert more slowly.
          //
          // ⚠️ Must inspect the CAUSE, not the outer error: readContract wraps everything
          // it catches — transport failures included — in a ContractFunctionExecutionError,
          // so keying on the outer name treats "the RPC timed out" as "the contract
          // reverted" and gives up on the very failures the fallback exists to survive.
          const reverted = typeof err?.walk === 'function'
            && err.walk((e) => e?.name === 'ContractFunctionRevertedError');
          if (reverted) throw err;
          lastError = err;
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw lastError;
  };

  const owner = await read('owner');
  const delay = await read('withdrawalDelay');
  const gas = await pub.getBalance({ address: account.address });

  console.log('\nAbaPayV4 on Base — withdrawal settings');
  console.log('──────────────────────────────────────');
  console.log(`  contract        ${V4}`);
  console.log(`  owner           ${owner}`);
  console.log(`  signer          ${account.address}  ${owner.toLowerCase() === account.address.toLowerCase() ? '✓ is owner' : '✗ NOT THE OWNER'}`);
  console.log(`  signer ETH      ${formatEther(gas)}`);
  console.log(`  withdrawalDelay ${delay} s  (${Number(delay) / 3600} h)${delay === 0n ? '  ← already instant' : ''}`);

  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    console.error('\n✗ The loaded key is not the contract owner; every call below would revert. Stopping.');
    process.exit(1);
  }

  const pending = {};
  for (const [sym, t] of Object.entries(TOKENS)) {
    const [amount, executableAt, destination] = await read('pendingWithdrawals', [t.address]);
    const balance = await read('balanceOf', [V4], t.address);
    pending[sym] = { amount, executableAt, destination, balance };
    const when = executableAt === 0n ? 'none queued' : new Date(Number(executableAt) * 1000).toISOString();
    const ready = executableAt !== 0n && Number(executableAt) * 1000 <= Date.now();
    console.log(
      `  ${sym.padEnd(4)} vault ${formatUnits(balance, t.decimals).padEnd(12)}` +
        (executableAt === 0n
          ? 'queued: none'
          : `queued: ${formatUnits(amount, t.decimals)} → ${destination}  executable ${when} ${ready ? '(READY)' : '(LOCKED)'}`)
    );
  }

  // ─── Send ──────────────────────────────────────────────────────────────────
  const txs = [];
  if (RESTORE !== null) {
    txs.push(['setWithdrawalDelay', [RESTORE], `setWithdrawalDelay(${RESTORE}) — restore the timelock`]);
  } else if (APPLY) {
    if (delay !== 0n) txs.push(['setWithdrawalDelay', [0n], 'setWithdrawalDelay(0) — future withdrawals become instant']);
    for (const [sym, p] of Object.entries(pending)) {
      if (p.executableAt === 0n) continue;
      txs.push(['cancelWithdrawal', [TOKENS[sym].address], `cancelWithdrawal(${sym}) — clear the stuck queue entry (no funds move)`]);
      if (WITHDRAW) {
        txs.push(['queueWithdrawal', [TOKENS[sym].address, p.destination, p.amount], `queueWithdrawal(${sym}, ${p.destination}, ${formatUnits(p.amount, TOKENS[sym].decimals)}) — re-queue at delay 0`]);
        txs.push(['executeWithdrawal', [TOKENS[sym].address], `executeWithdrawal(${sym}) — ⚠️ MOVES ${formatUnits(p.amount, TOKENS[sym].decimals)} ${sym} to ${p.destination}`]);
      }
    }
  }

  if (txs.length === 0) {
    console.log(
      APPLY || RESTORE !== null
        ? '\nNothing to do — the contract is already in the requested state.'
        : '\nRead-only run. Re-run with --apply to set the delay to 0 and clear the queue,\n' +
          'or --apply --withdraw to also push the queued withdrawal through immediately.'
    );
    return;
  }

  console.log('\nTransactions to send:');
  txs.forEach(([, , label], i) => console.log(`  ${i + 1}. ${label}`));

  for (const [functionName, callArgs, label] of txs) {
    process.stdout.write(`\n▶ ${label}\n  simulating… `);
    // Simulate first so a revert costs nothing and names its own reason, rather than
    // burning gas to find out on-chain.
    const { request } = await pub.simulateContract({ address: V4, abi: ABI, functionName, args: callArgs, account });
    process.stdout.write('ok, sending… ');
    const hash = await wallet.writeContract(request);
    console.log(`\n  tx  https://basescan.org/tx/${hash}`);
    const rc = await waitForReceipt(hash);
    console.log(`  status ${rc.status}  block ${rc.blockNumber}  gas ${rc.gasUsed}`);
    if (rc.status !== 'success') {
      console.error('✗ Reverted. Stopping before the next call so state stays predictable.');
      process.exit(1);
    }
  }

  console.log('\n── final state ──');
  console.log(`  withdrawalDelay ${await read('withdrawalDelay')} s`);
  for (const [sym, t] of Object.entries(TOKENS)) {
    const [amount, executableAt, destination] = await read('pendingWithdrawals', [t.address]);
    const balance = await read('balanceOf', [V4], t.address);
    console.log(
      `  ${sym.padEnd(4)} vault ${formatUnits(balance, t.decimals).padEnd(12)}` +
        (executableAt === 0n ? 'queued: none' : `queued: ${formatUnits(amount, t.decimals)} → ${destination}`)
    );
  }
  console.log(
    '\n⚠️ withdrawalDelay is now 0 — the vault has no cooling-off window against a stolen\n' +
      '   owner key. Restore it when you no longer need instant access:\n' +
      '     node scripts/base-instant-withdrawals.mjs --restore-delay 86400\n'
  );
}

main().catch((err) => {
  console.error(`\n✗ ${err?.shortMessage || err?.message || err}`);
  process.exit(1);
});
