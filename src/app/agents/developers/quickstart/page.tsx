import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, FolderGit2 } from "lucide-react";

export const metadata: Metadata = {
  title: "Quickstart Script — AbaPay Rails",
  description: "One runnable Node script that links a wallet, sets an on-chain allowance, and calls check_balance against production — verified live.",
};

// ⚡ THE ACTUAL SCRIPT, VERBATIM — examples/agent-quickstart.mjs in this repo. Kept in sync by
// hand (a build-time fetch-and-render was considered and skipped as unnecessary machinery for
// one file that changes rarely); the GitHub icon above the block exists specifically so a
// reader can always check this hasn't drifted from the real file.
const SCRIPT = `#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// AbaPay — headless agent quickstart
// ═══════════════════════════════════════════════════════════════════════════════
//
//   PRIVATE_KEY=0x...             npm install viem   (if running outside this repo)
//   CHAIN=CELO TOKEN=USDT node examples/agent-quickstart.mjs
//
// Env vars:
//   PRIVATE_KEY       required — the wallet that will hold the AbaPay spending allowance
//   CHAIN             CELO (default) or BASE
//   TOKEN             USDT/USDC/USAT on Celo, USDC/USDT on Base — defaults to the chain's lead token
//   ALLOWANCE         how much to approve, in the token's own units — default "2"
//   PIN               4-6 digits, yours to pick — default "1234" — CHANGE THIS
//   PAY               set to "1" to actually place a tiny real payment at the end
//   PAY_SERVICE / PAY_PROVIDER / PAY_ACCOUNT / PAY_AMOUNT_NGN
//                     only read when PAY=1 — defaults to a NGN 100 MTN airtime top-up
//
// This talks to PRODUCTION (abapays.com) and real mainnet contracts. Fund the
// wallet with a trivial amount before running.

import { createWalletClient, createPublicClient, http, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo, base } from 'viem/chains';

const APP_URL = 'https://www.abapays.com';

const CHAINS = {
  CELO: {
    chain: celo,
    rpc: 'https://forno.celo.org',
    abapay: '0x5df8aE2B963165b735B18Ca86B1ea448d2AA032C',
    tokens: {
      USDT: { address: '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e', decimals: 6 },
      USDC: { address: '0xceba9300f2b948710d2653dd7b07f33a8b32118c', decimals: 6 },
      USAT: { address: '0xd2ab3c9a02dbbab236bfec45d1d755df4267f771', decimals: 6 },
    },
    defaultToken: 'USDT',
  },
  BASE: {
    chain: base,
    rpc: 'https://mainnet.base.org',
    abapay: '0xC0A4dAA04DEd9c54D1239507B5A5E645761ef488',
    tokens: {
      USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
      USDT: { address: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', decimals: 6 },
    },
    defaultToken: 'USDC',
  },
};

async function main() {
  const account = privateKeyToAccount(process.env.PRIVATE_KEY);
  const cfg = CHAINS[(process.env.CHAIN || 'CELO').toUpperCase()];
  const tokenSymbol = process.env.TOKEN || cfg.defaultToken;
  const token = cfg.tokens[tokenSymbol];
  const pin = process.env.PIN || '1234';
  const allowanceRaw = parseUnits(process.env.ALLOWANCE || '2', token.decimals);

  const publicClient = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpc) });
  const walletClient = createWalletClient({ account, chain: cfg.chain, transport: http(cfg.rpc) });

  // ─── Step 1: prove wallet ownership, mint an MCP api_key ──────────────────────
  const timestamp = String(Date.now());
  const message = \`AbaPay Agent Action: POST:/api/agent/link: \${timestamp}\`;
  const signature = await walletClient.signMessage({ message });

  const linkRes = await fetch(\`\${APP_URL}/api/agent/link\`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-wallet-address': account.address,
      'x-wallet-signature': signature,
      'x-wallet-timestamp': timestamp,
    },
    body: JSON.stringify({
      wallet_address: account.address, channel: 'MCP', pin,
      approved_chain: (process.env.CHAIN || 'CELO').toUpperCase(),
      approved_token: tokenSymbol, mcp_key_label: 'agent-quickstart-example',
    }),
  });
  const { api_key: apiKey } = await linkRes.json();
  console.log(\`api_key minted: \${apiKey} — shown once, save it.\`);

  // ─── Step 2: on-chain — approve + setSpendingAllowance ────────────────────────
  const approveHash = await walletClient.writeContract({
    address: token.address,
    abi: [{ name: 'approve', type: 'function', stateMutability: 'nonpayable',
      inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }],
    functionName: 'approve', args: [cfg.abapay, allowanceRaw],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const allowanceHash = await walletClient.writeContract({
    address: cfg.abapay,
    abi: [{ name: 'setSpendingAllowance', type: 'function', stateMutability: 'nonpayable',
      inputs: [{ name: 'tokenAddress', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] }],
    functionName: 'setSpendingAllowance', args: [token.address, allowanceRaw],
  });
  await publicClient.waitForTransactionReceipt({ hash: allowanceHash });

  // ─── Step 3: call MCP tools with the api_key — no OAuth, no browser ───────────
  const balance = await fetch(\`\${APP_URL}/api/mcp\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'check_balance', arguments: { api_key: apiKey, chain: (process.env.CHAIN || 'CELO').toUpperCase() } },
    }),
  }).then((r) => r.json());
  console.log(balance.result?.content?.[0]?.text);
}

main().catch((err) => { console.error(err); process.exit(1); });`;

export default function QuickstartPage() {
  return (
    <>
      <Link href="/agents/developers" className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 mb-6">
        <ArrowLeft size={14} /> Developers
      </Link>

      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white mb-4 text-balance">Quickstart script</h1>
          <p className="text-lg text-slate-600 dark:text-slate-300 leading-relaxed font-medium max-w-2xl">
            Every step of the <Link href="/agents/a2a" className="underline hover:text-emerald-500">A2A / MCP linked-wallet path</Link> as one runnable file. Its wallet-signature auth and MCP call were verified live against production with a throwaway wallet before this was published.
          </p>
        </div>
        <a href="https://github.com/investorphem/AbaPay/blob/main/examples/agent-quickstart.mjs" target="_blank" rel="noopener noreferrer" title="View source on GitHub" className="p-2 text-slate-300 dark:text-slate-600 hover:text-slate-600 dark:hover:text-slate-300 flex-shrink-0">
          <FolderGit2 size={20} />
        </a>
      </div>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <h2 className="font-black text-slate-900 dark:text-white mb-3">Run it</h2>
        <div className="bg-[#0b0d0f] rounded-2xl border border-slate-800 overflow-hidden font-mono text-[11px]">
          <pre className="p-4 text-slate-300 overflow-x-auto whitespace-pre">{`PRIVATE_KEY=0x... npm install viem
CHAIN=CELO TOKEN=USDT node agent-quickstart.mjs`}</pre>
        </div>
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-3">
          Talks to production and real mainnet contracts — fund the wallet with a trivial amount first. Full env var reference (ALLOWANCE, PIN, PAY, …) is in the script&apos;s own header comment below.
        </p>
      </section>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8">
        <h2 className="font-black text-slate-900 dark:text-white mb-3">The script</h2>
        <div className="bg-[#0b0d0f] rounded-2xl border border-slate-800 overflow-hidden font-mono text-[11px] leading-relaxed max-h-[32rem] overflow-y-auto">
          <pre className="p-4 text-slate-300 overflow-x-auto whitespace-pre">{SCRIPT}</pre>
        </div>
      </section>
    </>
  );
}
