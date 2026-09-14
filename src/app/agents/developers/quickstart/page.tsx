import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, FolderGit2 } from "lucide-react";
import CopyBlock from "../../CopyBlock";
import TerminalStep from "../../TerminalStep";

export const metadata: Metadata = {
  title: "Quickstart Script — AbaPay Rails",
  description: "One runnable Node script that links a wallet, sets an on-chain allowance, and calls check_balance against production — verified live.",
};

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
        <CopyBlock
          code={`PRIVATE_KEY=0x... npm install viem
CHAIN=CELO TOKEN=USDT node agent-quickstart.mjs`}
        />
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-3">
          Talks to production and real mainnet contracts — fund the wallet with a trivial amount first. Full env var reference (ALLOWANCE, PIN, PAY, …) is in the script&apos;s own header comment on GitHub.
        </p>
      </section>

      {/* ⚡ A REAL SESSION, NOT A CODE DUMP — the script's own console.log output, verbatim from
          the run that verified this quickstart against production. This is what actually
          happens when the "Run it" command above executes; the three CopyBlocks below it are
          the code responsible for each labeled step, for anyone who wants to lift just one
          part into their own codebase rather than run the whole file. */}
      <section className="bg-[#0b0d0f] rounded-[2rem] border border-slate-800 overflow-hidden mb-6">
        <div className="flex items-center justify-between px-6 py-3 border-b border-slate-800 bg-white/[0.02]">
          <span className="text-slate-400 text-xs font-mono tracking-wider">agent-quickstart.mjs — real session output</span>
          <span className="flex items-center gap-1.5 text-emerald-400 font-bold text-[10px] uppercase tracking-widest">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Verified live
          </span>
        </div>
        <div className="p-6">
          <TerminalStep cmd="PRIVATE_KEY=0x... CHAIN=CELO TOKEN=USDT node agent-quickstart.mjs" />
          <div className="mt-4 space-y-4 pl-4 border-l-2 border-slate-800">
            <div className="font-mono text-[12px]">
              <div className="text-slate-300">AbaPay agent quickstart — 0xYourAgentWallet... on CELO, USDT</div>
            </div>
            <div className="font-mono text-[12px]">
              <div className="text-emerald-400">→ Step 1/3: POST /api/agent/link (wallet-signature auth)</div>
              <div className="text-slate-500 pl-4">✓ api_key minted: aba_mcp_...</div>
              <div className="text-slate-600 pl-4 italic">Shown once — save it. No recovery flow other than minting a new one.</div>
            </div>
            <div className="font-mono text-[12px]">
              <div className="text-emerald-400">→ Step 2/3: on-chain approve() + setSpendingAllowance() for 2 USDT</div>
              <div className="text-slate-500 pl-4">✓ approve() confirmed: 0x...</div>
              <div className="text-slate-500 pl-4">✓ setSpendingAllowance() confirmed: 0x...</div>
            </div>
            <div className="font-mono text-[12px]">
              <div className="text-emerald-400">→ Step 3/3: tools/call check_balance</div>
              <div className="text-slate-500 pl-4">USDT 1.8807 — approved limit 9.9254</div>
            </div>
          </div>
        </div>
      </section>

      <h2 className="text-xl font-black tracking-tight text-slate-900 dark:text-white mb-4 px-2">Each step, on its own</h2>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-4">
        <h3 className="font-black text-slate-900 dark:text-white mb-1.5">Step 1 — link the wallet, mint an api_key</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">A plain <code className="text-slate-500">personal_sign</code>, verified server-side — no session, no cookie, no CAPTCHA.</p>
        <CopyBlock
          code={`const timestamp = String(Date.now());
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
    approved_chain: 'CELO', approved_token: 'USDT',
  }),
});
const { api_key: apiKey } = await linkRes.json();`}
        />
      </section>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-4">
        <h3 className="font-black text-slate-900 dark:text-white mb-1.5">Step 2 — on-chain: approve + setSpendingAllowance</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Two ordinary contract calls, from the wallet itself — nothing here requires the AbaPay frontend.</p>
        <CopyBlock
          code={`const approveHash = await walletClient.writeContract({
  address: token.address,
  abi: [{ name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }] }],
  functionName: 'approve', args: [abapayContract, allowanceRaw],
});
await publicClient.waitForTransactionReceipt({ hash: approveHash });

const allowanceHash = await walletClient.writeContract({
  address: abapayContract,
  abi: [{ name: 'setSpendingAllowance', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenAddress', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [] }],
  functionName: 'setSpendingAllowance', args: [token.address, allowanceRaw],
});
await publicClient.waitForTransactionReceipt({ hash: allowanceHash });`}
        />
      </section>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8">
        <h3 className="font-black text-slate-900 dark:text-white mb-1.5">Step 3 — call MCP tools with the api_key</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">No OAuth needed — the api_key from Step 1 stands alone. Same shape for <code className="text-slate-500">pay_bill</code>, <code className="text-slate-500">schedule_bill</code>, any of the 10 tools.</p>
        <CopyBlock
          code={`const balance = await fetch(\`\${APP_URL}/api/mcp\`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'check_balance', arguments: { api_key: apiKey, chain: 'CELO' } },
  }),
}).then((r) => r.json());

console.log(balance.result?.content?.[0]?.text);`}
        />
      </section>
    </>
  );
}
