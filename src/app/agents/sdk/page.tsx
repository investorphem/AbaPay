import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, PackageCheck } from "lucide-react";
import CopyBlock from "../CopyBlock";

export const metadata: Metadata = {
  title: "abapay-sdk — TypeScript Client",
  description: "A TypeScript client wrapping AbaPay's x402 signing and MCP tool catalog into two functions.",
};

export default function SDKPage() {
  return (
    <>
      <Link href="/agents" className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 mb-6">
        <ArrowLeft size={14} /> Rails
      </Link>

      <div className="mb-8">
        <span className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">TypeScript</span>
        <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white mt-1 mb-4 text-balance">abapay-sdk</h1>
        <p className="text-lg text-slate-600 dark:text-slate-300 leading-relaxed font-medium max-w-2xl">
          Two functions, matching the two protocol-driven paths on this site. Signs with whatever <a href="https://viem.sh" target="_blank" rel="noopener noreferrer" className="underline hover:text-emerald-500">viem</a> account your agent already has — nothing hidden, the source is the same wire format documented on <Link href="/agents/x402" className="underline">/agents/x402</Link> and <Link href="/agents/a2a" className="underline">/agents/a2a</Link>.
        </p>
      </div>

      <a
        href="https://www.npmjs.com/package/abapay-sdk"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-between gap-3 bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-900/30 rounded-2xl p-4 mb-6 hover:border-emerald-200 dark:hover:border-emerald-800/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <PackageCheck size={18} className="text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          <span className="text-sm text-emerald-800 dark:text-emerald-300">
            Live on npm — <code className="text-emerald-900 dark:text-emerald-200">npm install abapay-sdk viem</code>
          </span>
        </div>
        <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400 flex-shrink-0">npmjs.com →</span>
      </a>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <h2 className="font-black text-slate-900 dark:text-white mb-1.5">Zero setup: payBillViaX402</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Fetches the 402 challenge, signs it, retries, returns the settlement.</p>
        <CopyBlock
          code={`import { privateKeyToAccount } from "viem/accounts";
import { payBillViaX402 } from "abapay-sdk";

const account = privateKeyToAccount(process.env.PRIVATE_KEY);

const result = await payBillViaX402({
  signer: account,
  bill: {
    serviceID: "mtn", serviceCategory: "AIRTIME",
    network: "MTN", billersCode: "08012345678",
    nairaAmount: 1000, token: "USDT",
  },
});

console.log(result.status, result.tx_hash);`}
        />
      </section>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <h2 className="font-black text-slate-900 dark:text-white mb-1.5">Linked wallet: AbaPayAgent</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Links once, sets the PIN in that same call, then reuses the api_key for the full tool catalog.</p>
        <CopyBlock
          code={`import { privateKeyToAccount } from "viem/accounts";
import { AbaPayAgent } from "abapay-sdk";

const account = privateKeyToAccount(process.env.PRIVATE_KEY);

// One-time -- no browser, PIN chosen right here.
const agent = await AbaPayAgent.link({ signer: account, pin: "1234" });

console.log(await agent.checkBalance());
await agent.payBill({
  pin: "1234", service: "AIRTIME", provider: "mtn",
  account_number: "08012345678", amount_ngn: 1000,
});`}
        />
      </section>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8">
        <h2 className="font-black text-slate-900 dark:text-white mb-3">Correctness, not just types</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed max-w-2xl mb-4">
          A test in the package asserts the signed typed-data&apos;s domain and message match a real 402 challenge byte-for-byte — the exact contract AbaPay&apos;s own server-side verification reconstructs to check the signature against. A silent drift there would be a signature that fails to verify; the test exists so that drift fails loudly instead.
        </p>
        <a href="https://github.com/investorphem/AbaPay/tree/main/sdk" className="text-sm font-bold text-emerald-600 dark:text-emerald-400 hover:underline">Source, tests, and the full README →</a>
      </section>
    </>
  );
}
