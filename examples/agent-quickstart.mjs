#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// AbaPay — headless agent quickstart
// ═══════════════════════════════════════════════════════════════════════════════
//
// The reproducible example docs/AGENT_INTEGRATION.md describes in prose, as one
// runnable script. No browser, no AbaPay account creation UI, no human in the loop
// beyond funding a wallet and picking a PIN. Everything here is a plain HTTP call or
// an on-chain transaction any agent runtime can make on its own.
//
//   PRIVATE_KEY=0x...             npm install viem   (if running outside this repo)
//   CHAIN=CELO TOKEN=USD₮ node examples/agent-quickstart.mjs
//
// Env vars:
//   PRIVATE_KEY       required — the wallet that will hold the AbaPay spending allowance
//   CHAIN             CELO (default) or BASE
//   TOKEN             USD₮/USDC/USA₮ on Celo, USDC/USD₮ on Base — defaults to the chain's lead token
//   ALLOWANCE         how much to approve, in the token's own units — default "2"
//   PIN               4-6 digits, yours to pick — default "1234" — CHANGE THIS
//   PAY               set to "1" to actually place a tiny real payment at the end (see PAY_* below)
//   PAY_SERVICE / PAY_PROVIDER / PAY_ACCOUNT / PAY_AMOUNT_NGN
//                     only read when PAY=1 — defaults to a ₦100 MTN airtime top-up
//
// This talks to PRODUCTION (abapays.com) and real mainnet contracts. Fund the
// wallet with a trivial amount before running — this is meant to prove the
// integration with real, small, verifiable on-chain activity, not to be a toy.
//
// ✅ Steps 1 and 3 (the wallet-signature auth and the MCP tools/call) are verified
// against production as of 2026-09-11 — a throwaway key ran this exact request shape
// against api.abapays.com, got back a real api_key, called check_balance with it, then
// unlinked itself via the same signature scheme on DELETE. Step 2 (approve +
// setSpendingAllowance) is standard ERC-20/viem usage and wasn't run with real funds,
// since that needs a funded wallet — but it's the same two calls README.md's own
// AbaPayV4 section documents, nothing novel.

import { createWalletClient, createPublicClient, http, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo, base } from 'viem/chains';

const APP_URL = 'https://www.abapays.com';

// Same addresses documented in README.md's AbaPayV4 section and ENV_SETUP.md §3 —
// the single source of truth for where payments land on each chain.
const CHAINS = {
  CELO: {
    chain: celo,
    rpc: 'https://forno.celo.org',
    abapay: '0x5df8aE2B963165b735B18Ca86B1ea448d2AA032C',
    tokens: {
      'USD₮': { address: '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e', decimals: 6 },
      USDC: { address: '0xceba9300f2b948710d2653dd7b07f33a8b32118c', decimals: 6 },
      'USA₮': { address: '0xd2ab3c9a02dbbab236bfec45d1d755df4267f771', decimals: 6 },
    },
    defaultToken: 'USD₮',
  },
  BASE: {
    chain: base,
    rpc: 'https://mainnet.base.org',
    abapay: '0xC0A4dAA04DEd9c54D1239507B5A5E645761ef488',
    tokens: {
      USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
      'USD₮': { address: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', decimals: 6 },
    },
    defaultToken: 'USDC',
  },
};

const ERC20_APPROVE_ABI = [
  {
    name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
];

const ABAPAY_ALLOWANCE_ABI = [
  {
    name: 'setSpendingAllowance', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenAddress', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [],
  },
];

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) fail('Set PRIVATE_KEY=0x... (a wallet you control, funded with a small amount of the token).');

  const chainKey = (process.env.CHAIN || 'CELO').toUpperCase();
  const cfg = CHAINS[chainKey];
  if (!cfg) fail(`CHAIN must be CELO or BASE, got "${chainKey}".`);

  const tokenSymbol = process.env.TOKEN || cfg.defaultToken;
  const token = cfg.tokens[tokenSymbol];
  if (!token) fail(`"${tokenSymbol}" is not offered on ${chainKey}. Options: ${Object.keys(cfg.tokens).join(', ')}`);

  const pin = process.env.PIN || '1234';
  if (!/^\d{4,6}$/.test(pin)) fail('PIN must be 4-6 digits.');

  const allowanceHuman = process.env.ALLOWANCE || '2';
  const allowanceRaw = parseUnits(allowanceHuman, token.decimals);

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpc) });
  const walletClient = createWalletClient({ account, chain: cfg.chain, transport: http(cfg.rpc) });

  console.log(`\nAbaPay agent quickstart — ${account.address} on ${chainKey}, ${tokenSymbol}\n`);

  // ─── Step 1: prove wallet ownership, mint an MCP api_key ──────────────────────
  // Exactly what src/utils/walletAuth.ts verifies server-side: a plain personal_sign
  // over "AbaPay Agent Action: <METHOD>:<PATH>: <timestamp>", sent as headers. No
  // session, no OAuth, no browser.
  console.log('→ Step 1/3: POST /api/agent/link (wallet-signature auth)');
  const timestamp = String(Date.now());
  const message = `AbaPay Agent Action: POST:/api/agent/link: ${timestamp}`;
  const signature = await walletClient.signMessage({ message });

  const linkRes = await fetch(`${APP_URL}/api/agent/link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-wallet-address': account.address,
      'x-wallet-signature': signature,
      'x-wallet-timestamp': timestamp,
    },
    body: JSON.stringify({
      wallet_address: account.address,
      channel: 'MCP',
      pin,
      approved_chain: chainKey,
      approved_token: tokenSymbol,
      mcp_key_label: 'agent-quickstart-example',
    }),
  });
  const linkData = await linkRes.json();
  if (!linkData.success) fail(`Link failed: ${linkData.message}`);
  const apiKey = linkData.api_key;
  console.log(`  ✓ api_key minted: ${apiKey}`);
  console.log('  ⚠️  Shown once — save it. There is no recovery flow other than minting a new one the same way.\n');

  // ─── Step 2: on-chain — approve + setSpendingAllowance ────────────────────────
  // Two ordinary contract calls. setSpendingAllowance can ONLY ever be called by the
  // wallet setting its own allowance (contracts/AbaPayV4.sol) — nothing here, or on
  // AbaPay's backend, can raise it on your behalf.
  console.log(`→ Step 2/3: on-chain approve() + setSpendingAllowance() for ${allowanceHuman} ${tokenSymbol}`);

  const approveHash = await walletClient.writeContract({
    address: token.address, abi: ERC20_APPROVE_ABI, functionName: 'approve',
    args: [cfg.abapay, allowanceRaw],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log(`  ✓ approve() confirmed: ${approveHash}`);

  const allowanceHash = await walletClient.writeContract({
    address: cfg.abapay, abi: ABAPAY_ALLOWANCE_ABI, functionName: 'setSpendingAllowance',
    args: [token.address, allowanceRaw],
  });
  await publicClient.waitForTransactionReceipt({ hash: allowanceHash });
  console.log(`  ✓ setSpendingAllowance() confirmed: ${allowanceHash}\n`);

  // ─── Step 3: call MCP tools with the api_key — no OAuth, no browser ───────────
  async function mcpCall(name, args) {
    const res = await fetch(`${APP_URL}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name, arguments: { api_key: apiKey, ...args } },
      }),
    });
    return res.json();
  }

  console.log('→ Step 3/3: tools/call check_balance');
  const balance = await mcpCall('check_balance', { chain: chainKey });
  const balanceText = balance.result?.content?.[0]?.text || JSON.stringify(balance);
  console.log(`  ${balanceText}\n`);

  if (process.env.PAY === '1') {
    const service = process.env.PAY_SERVICE || 'AIRTIME';
    const provider = process.env.PAY_PROVIDER || 'mtn';
    const accountNumber = process.env.PAY_ACCOUNT || fail('Set PAY_ACCOUNT (a real phone number) to actually pay.');
    const amountNgn = Number(process.env.PAY_AMOUNT_NGN || 100);

    console.log(`→ Bonus: tools/call pay_bill — ${service} ${provider} ₦${amountNgn} to ${accountNumber}`);
    const pay = await mcpCall('pay_bill', {
      pin, service, provider, account_number: accountNumber, amount_ngn: amountNgn,
      chain: chainKey, token: tokenSymbol,
    });
    const payText = pay.result?.content?.[0]?.text || JSON.stringify(pay);
    console.log(`  ${payText}\n`);
  } else {
    console.log('Set PAY=1 (plus PAY_ACCOUNT) to place a real tiny payment with this same api_key + PIN.\n');
  }

  console.log(`Remaining allowance after this run: check_balance's "limit" field above (approved ${formatUnits(allowanceRaw, token.decimals)} ${tokenSymbol} in step 2).`);
}

main().catch((err) => fail(err?.stack || String(err)));
