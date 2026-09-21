import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, FolderGit2 } from "lucide-react";

export const metadata: Metadata = {
  title: "Error Codes — AbaPay Rails",
  description: "Every real error code AbaPay's x402, MCP, and A2A surfaces can return — HTTP status, code, retryable, and what to do about it.",
};

const HTTP_STATUS: { code: string; meaning: string; where: string }[] = [
  { code: "200", meaning: "Settled, or a JSON-RPC-framed result (MCP/A2A always return 200 at the transport level, even for a tool-level error — see the JSON-RPC table below).", where: "REST, MCP, A2A" },
  { code: "402", meaning: "Payment Required — a genuine x402 challenge, or a signed authorization that failed verification (see x402 error codes below).", where: "x402 / REST" },
  { code: "401", meaning: "No credential at all (missing api_key and no OAuth token) — carries a WWW-Authenticate header pointing at the OAuth flow.", where: "MCP" },
  { code: "409", meaning: "This exact payment is already locked/being processed — don't retry, it's not a fresh failure.", where: "x402 / REST" },
  { code: "429", meaning: "Rate limited — 60/min per-IP on the whole MCP/A2A surface, and separately per-credential on money-moving calls (pay_bill 10/min, schedule_bill 5/min, pay_bill_batch 5/min). Carries a Retry-After header.", where: "MCP, A2A" },
  { code: "500", meaning: "Server-side failure unrelated to the caller's request (token not configured, vault misconfigured, or an unhandled exception).", where: "x402 / REST" },
];

const X402_CODES: { code: string; retryable: boolean; meaning: string }[] = [
  { code: "MALFORMED_AUTHORIZATION", retryable: false, meaning: "The signed authorization was incomplete or its numbers unreadable — a client-side bug in how it was built, not a transient issue." },
  { code: "WRONG_RECIPIENT", retryable: false, meaning: "The authorization named a different payTo than this specific payment's challenge — stale or reused authorization." },
  { code: "NOT_YET_VALID", retryable: false, meaning: "validAfter is in the future relative to the server's clock — usually the caller's device clock is off. Fix the clock, then retry." },
  { code: "AUTHORIZATION_EXPIRED", retryable: true, meaning: "validBefore already passed. Sign a fresh authorization against a fresh challenge and retry." },
  { code: "AMOUNT_MISMATCH", retryable: false, meaning: "The signed value doesn't match this bill's required amount — the challenge and the signature disagree on price." },
  { code: "Malformed X-PAYMENT header", retryable: false, meaning: "The X-PAYMENT header wasn't valid base64-encoded JSON in the expected shape." },
  { code: "Facilitator error (&lt;http status&gt;)", retryable: true, meaning: "Celo's x402 facilitator itself returned a non-success status while settling. Not AbaPay's failure — safe to retry." },
  { code: "Facilitator temporarily unavailable", retryable: true, meaning: "The facilitator couldn't be reached at all. Retry with backoff." },
];

const SETTLEMENT_STATUS: { status: string; meaning: string }[] = [
  { status: "SUCCESS", meaning: "Bill vended, or reliably queued for background delivery." },
  { status: "FAILED_VENDING", meaning: "Payment settled on-chain, but the underlying bill purchase (VTpass) failed — enters the automatic on-chain refund flow. See the Custody chapter in the handbook." },
  { status: "TIMEOUT", meaning: "This exact payment was already being processed when the request landed — a duplicate submission, not a fresh failure. Don't resubmit." },
  { status: "SYSTEM_CRASH", meaning: "An unhandled exception during settlement. Treat as pending, not failed — check transaction_history / the receipt before assuming nothing happened." },
];

const JSONRPC_CODES: { code: string; meaning: string }[] = [
  { code: "-32700", meaning: "Parse error — the request body wasn't valid JSON." },
  { code: "-32600", meaning: "Invalid Request — missing/malformed jsonrpc, method, or id." },
  { code: "-32601", meaning: "Method not found." },
  { code: "-32602", meaning: "Invalid params — a required field was missing or the wrong type. Check the tool's parameter table on the MCP or A2A page." },
  { code: "-32603", meaning: "Internal error, unrelated to the request itself." },
  { code: "-32001", meaning: "Unauthorized — no valid credential. Carries a WWW-Authenticate pointer to start OAuth." },
  { code: "-32004", meaning: "Unsupported operation (A2A spec §8)." },
];

export default function ErrorsPage() {
  return (
    <>
      <Link href="/agents" className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 mb-6">
        <ArrowLeft size={14} /> Rails
      </Link>

      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <span className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">Reference</span>
          <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white mt-1 mb-4 text-balance">Error codes</h1>
          <p className="text-lg text-slate-600 dark:text-slate-300 leading-relaxed font-medium max-w-2xl">
            Every real error code AbaPay&apos;s rails can return, pulled straight from the route handlers — not a curated happy-path subset. If something failed, it&apos;s one of these.
          </p>
        </div>
        <a href="https://github.com/investorphem/AbaPay/blob/main/src/lib/x402Settle.ts" target="_blank" rel="noopener noreferrer" title="View source on GitHub" className="p-2 text-slate-300 dark:text-slate-600 hover:text-slate-600 dark:hover:text-slate-300 flex-shrink-0">
          <FolderGit2 size={20} />
        </a>
      </div>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <h2 className="font-black text-slate-900 dark:text-white mb-4">HTTP status codes</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-slate-800/60">
                <th className="py-2 pr-4 font-bold">Status</th>
                <th className="py-2 pr-4 font-bold">Meaning</th>
                <th className="py-2 font-bold">Where</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
              {HTTP_STATUS.map((r) => (
                <tr key={r.code}>
                  <td className="py-2.5 pr-4"><code className="text-emerald-600 dark:text-emerald-400 font-bold">{r.code}</code></td>
                  <td className="py-2.5 pr-4 text-slate-600 dark:text-slate-400">{r.meaning}</td>
                  <td className="py-2.5 text-slate-400 dark:text-slate-500 text-xs whitespace-nowrap">{r.where}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <h2 className="font-black text-slate-900 dark:text-white mb-1.5">x402 challenge / settlement errors</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4 max-w-2xl">
          Carried in the 402 response body as <code className="text-slate-500">errorCode</code>, alongside a human-readable <code className="text-slate-500">error</code> string and a <code className="text-slate-500">retryable</code> flag — check <code className="text-slate-500">retryable</code> before deciding whether to sign a fresh authorization and try again.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-slate-800/60">
                <th className="py-2 pr-4 font-bold">Code</th>
                <th className="py-2 pr-4 font-bold">Retryable</th>
                <th className="py-2 font-bold">Meaning</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
              {X402_CODES.map((r) => (
                <tr key={r.code}>
                  <td className="py-2.5 pr-4"><code className="text-emerald-600 dark:text-emerald-400 font-bold whitespace-nowrap" dangerouslySetInnerHTML={{ __html: r.code }} /></td>
                  <td className="py-2.5 pr-4">
                    {r.retryable ? (
                      <span className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">Yes</span>
                    ) : (
                      <span className="text-[10px] font-black uppercase tracking-widest text-red-500">No</span>
                    )}
                  </td>
                  <td className="py-2.5 text-slate-600 dark:text-slate-400">{r.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <h2 className="font-black text-slate-900 dark:text-white mb-1.5">Settlement status (200 response body)</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4 max-w-2xl">
          The <code className="text-slate-500">status</code> field on a settled x402/REST response — a 200 HTTP status doesn&apos;t always mean the money-to-bill leg finished cleanly.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-slate-800/60">
                <th className="py-2 pr-4 font-bold">Status</th>
                <th className="py-2 font-bold">Meaning</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
              {SETTLEMENT_STATUS.map((r) => (
                <tr key={r.status}>
                  <td className="py-2.5 pr-4"><code className="text-emerald-600 dark:text-emerald-400 font-bold whitespace-nowrap">{r.status}</code></td>
                  <td className="py-2.5 text-slate-600 dark:text-slate-400">{r.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8">
        <h2 className="font-black text-slate-900 dark:text-white mb-1.5">MCP / A2A JSON-RPC error codes</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4 max-w-2xl">
          Standard JSON-RPC 2.0 codes (spec §8) plus AbaPay-specific ones. A tool-level error (e.g. a wrong PIN) comes back as normal <code className="text-slate-500">result</code> text, not one of these — these are transport/protocol-level failures.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-slate-800/60">
                <th className="py-2 pr-4 font-bold">Code</th>
                <th className="py-2 font-bold">Meaning</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
              {JSONRPC_CODES.map((r) => (
                <tr key={r.code}>
                  <td className="py-2.5 pr-4"><code className="text-emerald-600 dark:text-emerald-400 font-bold whitespace-nowrap">{r.code}</code></td>
                  <td className="py-2.5 text-slate-600 dark:text-slate-400">{r.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-4">
          Invalid or revoked API keys return the same plain-text message regardless of which tool was called: <em>&quot;Invalid or revoked API key. Create a new one in the AbaPay app under Agent Hub → MCP.&quot;</em>
        </p>
      </section>
    </>
  );
}
