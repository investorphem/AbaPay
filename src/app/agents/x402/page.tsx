import type { Metadata } from "next";
import Link from "next/link";
import { Ban, ArrowLeft } from "lucide-react";

export const metadata: Metadata = {
  title: "x402 — Zero-Setup Agent Payments",
  description: "Pay a real-world bill on Celo with no account, no API key, and no PIN — a 402 challenge, one signature, settled.",
};

// ⚡ EVERY FIELD NAME, ADDRESS AND NETWORK ID BELOW IS REAL — copied from
// src/app/api/pay/x402/route.ts's actual challenge construction (`acceptEntry`, the v1/v2
// challenge bodies) and public/openapi.json's Celo `x-payment-info.protocols` entries. The
// dollar amount and tx hash are illustrative (a real amount is computed server-side from the
// live NGN rate at request time); everything else is exactly what a real call gets back.
const CELO_NETWORK = "eip155:42220";
const CELO_USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
const CELO_USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const CELO_VAULT = "0x5df8aE2B963165b735B18Ca86B1ea448d2AA032C";

export default function X402Page() {
  return (
    <>
      <Link href="/agents" className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 mb-6">
        <ArrowLeft size={14} /> Rails
      </Link>

      <div className="mb-8">
        <span className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">Zero setup</span>
        <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white mt-1 mb-4 text-balance">x402</h1>
        <p className="text-lg text-slate-600 dark:text-slate-300 leading-relaxed font-medium max-w-2xl">
          An independent agent — say, a Cowrie-style FX agent holding a Celo wallet — never needs to know AbaPay exists in advance. The whole exchange happens over plain HTTP, challenge and response.
        </p>
      </div>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <h2 className="font-black text-slate-900 dark:text-white mb-4">The flow</h2>
        <ol className="space-y-3">
          {[
            "Holds or uses a Celo wallet.",
            "Calls AbaPay's quote / pay_bill endpoint directly.",
            "Gets 402 Payment Required back, with the exact price and asset.",
            "Signs an EIP-3009 transferWithAuthorization with that same wallet — nothing else.",
            "Retries the request with the signed authorization attached.",
            "AbaPay settles on Celo via Celo's own x402 facilitator and vends the bill.",
          ].map((step, i) => (
            <li key={step} className="flex items-start gap-3 text-sm text-slate-700 dark:text-slate-300">
              <span className="w-5 h-5 rounded-full bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/50 text-emerald-600 dark:text-emerald-400 text-[10px] font-black flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</span>
              {step}
            </li>
          ))}
        </ol>
      </section>

      <section className="bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/30 rounded-[2rem] p-6 sm:p-8 mb-6">
        <p className="text-xs font-black uppercase tracking-widest text-red-500 dark:text-red-400 mb-3 flex items-center gap-1.5"><Ban size={13} /> Never required for this path</p>
        <div className="flex flex-wrap gap-2">
          {["abapays.com account", "Agent Hub", "API key", "PIN", "Wallet-signature link"].map((x) => (
            <span key={x} className="text-xs font-medium text-slate-600 dark:text-slate-400 bg-white dark:bg-[#111114] border border-slate-200 dark:border-slate-800 rounded-full px-3 py-1">{x}</span>
          ))}
        </div>
      </section>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <h2 className="font-black text-slate-900 dark:text-white mb-4">Request &amp; response</h2>
        <div className="bg-[#0b0d0f] rounded-2xl border border-slate-800 overflow-hidden font-mono text-[11px] leading-relaxed mb-4">
          <div className="px-4 py-2.5 border-b border-slate-800 bg-white/[0.02] text-slate-400">POST /api/pay/x402 — no X-PAYMENT header yet</div>
          <pre className="p-4 text-slate-300 overflow-x-auto whitespace-pre">{`{
  "serviceID": "mtn", "serviceCategory": "AIRTIME",
  "network": "MTN", "billersCode": "08012345678",
  "nairaAmount": 1000, "token": "USDT",
  "blockchain": "CELO", "wallet_address": "0xYourAgentWallet..."
}`}</pre>
        </div>
        <div className="bg-[#0b0d0f] rounded-2xl border border-slate-800 overflow-hidden font-mono text-[11px] leading-relaxed mb-4">
          <div className="px-4 py-2.5 border-b border-slate-800 bg-white/[0.02] text-slate-400">← 402 Payment Required (real field names)</div>
          <pre className="p-4 text-slate-300 overflow-x-auto whitespace-pre">{`{
  "x402Version": 1,
  "error": "Payment required",
  "accepts": [{
    "scheme": "exact",
    "network": "${CELO_NETWORK}",
    "asset": "${CELO_USDT}",
    "payTo": "${CELO_VAULT}",
    "maxTimeoutSeconds": 86400,
    "extra": { "name": "Tether USD", "version": "1", "primaryType": "TransferWithAuthorization" }
  }]
}`}</pre>
        </div>
        <div className="bg-[#0b0d0f] rounded-2xl border border-slate-800 overflow-hidden font-mono text-[11px] leading-relaxed">
          <div className="px-4 py-2.5 border-b border-slate-800 bg-white/[0.02] text-slate-400">POST /api/pay/x402 -H X-PAYMENT: &lt;base64 signed authorization&gt; → 200 OK</div>
          <pre className="p-4 text-slate-300 overflow-x-auto whitespace-pre">{`{
  "success": true, "status": "SUCCESS",
  "tx_hash": "0x91a3...4f2c", "request_id": "req_...",
  "purchased_code": null, "units": null
}`}</pre>
        </div>
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-4">
          Both USDC (<code className="text-slate-500">{CELO_USDC.slice(0, 10)}…</code>) and USD₮ settle via Celo&apos;s own x402 facilitator — each implements EIP-3009. Full field reference: <a href="https://abapays.com/openapi.json" className="underline hover:text-emerald-500">openapi.json</a>.
        </p>
      </section>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8">
        <h2 className="font-black text-slate-900 dark:text-white mb-4">Don&apos;t hand-roll the signing</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-4 max-w-2xl">
          <code className="text-slate-500">abapay-sdk</code>&apos;s <code className="text-slate-500">payBillViaX402()</code> does exactly the three requests and one signature above — pass it a viem account and the bill details, get back the settlement result.
        </p>
        <Link href="/agents/sdk" className="text-sm font-bold text-emerald-600 dark:text-emerald-400 hover:underline">See the SDK →</Link>
      </section>
    </>
  );
}
