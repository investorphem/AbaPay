#!/usr/bin/env node
// ⚡ VAULT CONFIGURATION CHECK — read-only. Holds no key and sends nothing.
//
// Diffs the LIVE configuration of every AbaPay vault against config/vaults.json and, for each
// difference, prints the owner transaction that fixes it (target, function, args and raw
// calldata), in a safe order. The owner sends those themselves — from a block explorer's
// "Write Contract" tab, their wallet, or (after the multisig migration) a Safe Transaction
// Builder batch, which `--safe-json` emits per chain.
//
// Exit code is 1 when anything differs, so this doubles as a drift check that can be run by
// hand or from CI (read-only RPC calls only).
//
//   node scripts/vault-config.mjs                 # human-readable diff + transactions
//   node scripts/vault-config.mjs --safe-json     # also write Safe Transaction Builder files
//
// Why each expected value is what it is: ABAPAY_IMPLEMENTATION_PLAN.md M0.3.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, fallback, parseAbi, encodeFunctionData, formatUnits, parseUnits } from 'viem';
import { celo, base } from 'viem/chains';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'config', 'vaults.json'), 'utf8'));
const wantSafeJson = process.argv.includes('--safe-json');

const CHAINS = {
  celo: { chain: celo, rpcs: ['https://forno.celo.org', 'https://rpc.ankr.com/celo'] },
  base: { chain: base, rpcs: ['https://mainnet.base.org', 'https://base.publicnode.com'] },
};
const ZERO = '0x0000000000000000000000000000000000000000';

const ABI = parseAbi([
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function relayer() view returns (address)',
  'function withdrawalDelay() view returns (uint256)',
  'function isSupportedToken(address) view returns (bool)',
  'function maxRefundPerTx(address) view returns (uint256)',
  'function maxAgentPaymentPerTx(address) view returns (uint256)',
  'function setTokenSupport(address tokenAddress, bool status)',
  'function setMaxRefund(address tokenAddress, uint256 maxAmount)',
  'function setMaxAgentPayment(address tokenAddress, uint256 maxAmount)',
  'function setWithdrawalDelay(uint256 newDelay)',
  'function setRelayer(address newRelayer)',
  'function pause()',
]);

const clients = Object.fromEntries(Object.entries(CHAINS).map(([k, v]) => [
  k, createPublicClient({ chain: v.chain, transport: fallback(v.rpcs.map((u) => http(u, { timeout: 15_000, retryCount: 2 }))) }),
]));

async function read(chainKey, address, functionName, args = []) {
  try {
    return { ok: true, value: await clients[chainKey].readContract({ address, abi: ABI, functionName, args }) };
  } catch (e) {
    return { ok: false, error: e.shortMessage || e.message };
  }
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const fmtAmount = (raw, decimals) => `${formatUnits(raw, decimals)}`;

const txs = [];      // { chain, vault, to, fn, args, data, why }
const problems = []; // human-readable diffs, including ones no transaction can fix here
function planTx(vault, fn, args, why) {
  txs.push({ chain: vault.chain, vault: vault.name, to: vault.address, fn, args, data: encodeFunctionData({ abi: ABI, functionName: fn, args }), why });
}

for (const vault of cfg.vaults) {
  const lines = [];
  const note = (ok, text) => lines.push(`${ok ? '  ✓' : '  ✗'} ${text}`);
  const tokens = cfg.tokens[vault.chain];

  const owner = await read(vault.chain, vault.address, 'owner');
  if (!owner.ok) note(false, `owner(): unreadable (${owner.error})`);
  else if (!same(owner.value, cfg.owner)) { note(false, `owner ${owner.value} ≠ expected ${cfg.owner}`); problems.push(`${vault.name}: unexpected owner ${owner.value}`); }
  else note(true, `owner ${owner.value}`);

  // Token support first — for a retiring vault, closing intake is the step that matters.
  for (const [symbol, want] of Object.entries(vault.tokens)) {
    const tok = tokens[symbol];
    const sup = await read(vault.chain, vault.address, 'isSupportedToken', [tok.address]);
    if (!sup.ok) { note(false, `${symbol} isSupportedToken: unreadable (${sup.error})`); problems.push(`${vault.name}: ${symbol} support unreadable`); continue; }
    if (sup.value !== want.supported) {
      note(false, `${symbol} supported=${sup.value}, expected ${want.supported}`);
      planTx(vault, 'setTokenSupport', [tok.address, want.supported], `${symbol} ${want.supported ? 'enable' : 'disable'}`);
    } else note(true, `${symbol} supported=${sup.value}`);
  }

  if (vault.kind === 'v3' || vault.kind === 'v4') {
    const relayer = await read(vault.chain, vault.address, 'relayer');
    const wantRelayer = vault.relayerEnabled ? cfg.relayer : ZERO;
    if (!relayer.ok) note(false, `relayer: unreadable (${relayer.error})`);
    else if (!same(relayer.value, wantRelayer)) {
      note(false, `relayer ${relayer.value}, expected ${wantRelayer}`);
      planTx(vault, 'setRelayer', [wantRelayer], vault.relayerEnabled ? 'restore relayer' : 'disable relayer on a retired vault');
    } else note(true, `relayer ${relayer.value}`);

    for (const [symbol, want] of Object.entries(vault.tokens)) {
      const tok = tokens[symbol];
      for (const [field, getter, setter] of [['maxRefund', 'maxRefundPerTx', 'setMaxRefund'], ['maxAgentPayment', 'maxAgentPaymentPerTx', 'setMaxAgentPayment']]) {
        if (want[field] === undefined) continue;
        const cur = await read(vault.chain, vault.address, getter, [tok.address]);
        const wantRaw = parseUnits(want[field], tok.decimals);
        if (!cur.ok) { note(false, `${symbol} ${getter}: unreadable (${cur.error})`); problems.push(`${vault.name}: ${symbol} ${getter} unreadable`); continue; }
        if (cur.value !== wantRaw) {
          note(false, `${symbol} ${getter}=${fmtAmount(cur.value, tok.decimals)}, expected ${want[field]}`);
          planTx(vault, setter, [tok.address, wantRaw], `${symbol} ${field} -> ${want[field]}`);
        } else note(true, `${symbol} ${getter}=${want[field]}`);
      }
    }
  }

  if (vault.kind === 'v4' && vault.withdrawalDelaySeconds !== undefined) {
    const delay = await read(vault.chain, vault.address, 'withdrawalDelay');
    if (!delay.ok) note(false, `withdrawalDelay: unreadable (${delay.error})`);
    else if (delay.value !== BigInt(vault.withdrawalDelaySeconds)) {
      note(false, `withdrawalDelay=${delay.value}s, expected ${vault.withdrawalDelaySeconds}s`);
      planTx(vault, 'setWithdrawalDelay', [BigInt(vault.withdrawalDelaySeconds)], 'restore the withdrawal timelock');
    } else note(true, `withdrawalDelay=${delay.value}s`);
  }

  // pause() last — it is the one step that is not a simple setter swap on the way back.
  if ((vault.kind === 'v3' || vault.kind === 'v4') && vault.paused !== undefined) {
    const paused = await read(vault.chain, vault.address, 'paused');
    if (!paused.ok) note(false, `paused: unreadable (${paused.error})`);
    else if (paused.value !== vault.paused) {
      note(false, `paused=${paused.value}, expected ${vault.paused}`);
      if (vault.paused) planTx(vault, 'pause', [], 'pause a retired vault');
      else problems.push(`${vault.name}: paused but expected live — call unpause() deliberately`);
    } else note(true, `paused=${paused.value}`);
  }

  // Informational: what the vault holds. A retiring vault with a balance still needs a sweep
  // (V3: queueWithdrawal -> wait its fixed 24h -> executeWithdrawal; V1: withdrawFunds).
  const held = [];
  for (const [symbol, tok] of Object.entries(tokens)) {
    try {
      const bal = await clients[vault.chain].readContract({
        address: tok.address, abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
        functionName: 'balanceOf', args: [vault.address],
      });
      if (bal > 0n) held.push(`${fmtAmount(bal, tok.decimals)} ${symbol}`);
    } catch { held.push(`${symbol}: unreadable`); }
  }
  lines.push(`  · holds: ${held.length ? held.join(', ') : 'nothing'}`);

  console.log(`\n${vault.name}  [${vault.chain}] ${vault.address}`);
  console.log(lines.join('\n'));
}

console.log('\n' + '─'.repeat(78));
if (txs.length === 0 && problems.length === 0) {
  console.log('All vaults match config/vaults.json. Nothing to send.');
  process.exit(0);
}

// Most urgent first, across ALL vaults: closing intake of an unsafe token (USDm — the /api/pay
// decimals attack, audit P-2) and cutting the relayer off a retired vault stop live risk; caps
// and the timelock bound what a compromised owner key could do, which is slower-moving risk.
const PRIORITY = { setTokenSupport: 0, setRelayer: 1, pause: 2, setMaxRefund: 3, setWithdrawalDelay: 4, setMaxAgentPayment: 5 };
txs.sort((a, b) => (PRIORITY[a.fn] ?? 9) - (PRIORITY[b.fn] ?? 9));

if (txs.length) {
  console.log(`\nOWNER TRANSACTIONS TO SEND (${txs.length}), in order. Send each from the owner wallet`);
  console.log(`(${cfg.owner}) on the named chain, and wait for it to confirm before the next.\n`);
  txs.forEach((t, i) => {
    const args = t.args.map((a) => (typeof a === 'bigint' ? a.toString() : String(a))).join(', ');
    console.log(`${String(i + 1).padStart(2)}. [${t.chain}] ${t.vault}`);
    console.log(`    to:   ${t.to}`);
    console.log(`    call: ${t.fn}(${args})   — ${t.why}`);
    console.log(`    data: ${t.data}\n`);
  });
}
if (problems.length) {
  console.log('NOT FIXABLE BY THIS SCRIPT — needs a decision:');
  problems.forEach((p) => console.log(`  • ${p}`));
}

if (wantSafeJson) {
  for (const chainKey of Object.keys(CHAINS)) {
    const batch = txs.filter((t) => t.chain === chainKey);
    if (!batch.length) continue;
    const file = join(root, `vault-config.${chainKey}.safe-batch.json`);
    writeFileSync(file, JSON.stringify({
      version: '1.0',
      chainId: String(CHAINS[chainKey].chain.id),
      createdAt: Date.now(),
      meta: { name: `AbaPay vault hardening (${chainKey})`, description: 'Generated by scripts/vault-config.mjs from config/vaults.json' },
      transactions: batch.map((t) => ({ to: t.to, value: '0', data: t.data })),
    }, null, 2));
    console.log(`Wrote ${file}`);
  }
}

process.exit(1);
