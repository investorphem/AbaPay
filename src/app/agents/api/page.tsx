import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, FolderGit2 } from "lucide-react";
import CopyBlock from "../CopyBlock";
import X402Playground from "../X402Playground";

export const metadata: Metadata = {
  title: "REST API — AbaPay Rails",
  description: "Plain OpenAPI 3.1 reference for AbaPay's Celo settlement endpoint — no MCP, no A2A, no protocol wrapper required.",
};

export default function APIPage() {
  return (
    <>
      <Link href="/agents" className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 mb-6">
        <ArrowLeft size={14} /> Rails
      </Link>

      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <span className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">Plain HTTP</span>
          <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white mt-1 mb-4 text-balance">REST API</h1>
          <p className="text-lg text-slate-600 dark:text-slate-300 leading-relaxed font-medium max-w-2xl">
            The same settlement rail as <Link href="/agents/x402" className="underline hover:text-emerald-500">x402</Link>, described as a plain OpenAPI 3.1 document for any HTTP client that isn&apos;t speaking MCP or A2A. One endpoint, Celo-only, machine-readable.
          </p>
        </div>
        <a href="https://abapays.com/openapi.json" target="_blank" rel="noopener noreferrer" title="View raw openapi.json" className="p-2 text-slate-300 dark:text-slate-600 hover:text-slate-600 dark:hover:text-slate-300 flex-shrink-0">
          <FolderGit2 size={20} />
        </a>
      </div>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <span className="text-[11px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/50 rounded-lg px-2.5 py-1">POST</span>
          <code className="text-sm font-bold text-slate-900 dark:text-white">/api/pay/x402</code>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-5 max-w-2xl">
          Settles a real-world bill payment. The caller pays in a supported Celo stablecoin; on confirmed settlement, AbaPay vends the underlying service and returns the result. Price is dynamic — it equals the live value of the bill, so there is no fixed catalog price for this resource.
        </p>

        <h2 className="text-xs font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-3">Request body</h2>
        <div className="overflow-x-auto mb-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-slate-800/60">
                <th className="py-2 pr-4 font-bold">Field</th>
                <th className="py-2 pr-4 font-bold">Type</th>
                <th className="py-2 font-bold">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
              {[
                ["serviceID", "string", 'VTpass service identifier, e.g. "mtn", "ikeja-electric"'],
                ["serviceCategory", "string", "AIRTIME | DATA | ELECTRICITY | CABLE | BANK | EDUCATION"],
                ["network", "string", "Provider name, e.g. MTN, IKEJA-ELECTRIC, DSTV"],
                ["billersCode", "string", "Phone number, meter number, or smartcard/IUC number"],
                ["nairaAmount", "number", "Bill amount in NGN — the source of truth for pricing"],
                ["token", "string", '"USDC" or "USDT" — both implement EIP-3009 on Celo'],
                ["blockchain", "string", '"CELO" — this site\'s rails are Celo-only'],
                ["wallet_address", "string", "The paying wallet, cross-checked against the signed authorization"],
              ].map(([field, type, desc]) => (
                <tr key={field}>
                  <td className="py-2.5 pr-4"><code className="text-emerald-600 dark:text-emerald-400 font-bold">{field}</code></td>
                  <td className="py-2.5 pr-4 text-slate-400 dark:text-slate-500 font-mono text-xs">{type}</td>
                  <td className="py-2.5 text-slate-600 dark:text-slate-400">{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 className="text-xs font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-3">Responses</h2>
        <div className="grid sm:grid-cols-2 gap-3 mb-5">
          <div className="bg-slate-50 dark:bg-white/5 rounded-xl p-4 border border-slate-100 dark:border-slate-800/60">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-black text-emerald-600 dark:text-emerald-400">200</span>
              <span className="text-xs font-bold text-slate-700 dark:text-slate-300">Settled</span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">Bill vended, or queued for background processing.</p>
          </div>
          <div className="bg-slate-50 dark:bg-white/5 rounded-xl p-4 border border-slate-100 dark:border-slate-800/60">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-black text-red-500">402</span>
              <span className="text-xs font-bold text-slate-700 dark:text-slate-300">Payment Required</span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">Standard x402 challenge — see <Link href="/agents/x402" className="underline">/agents/x402</Link>.</p>
          </div>
        </div>

        <CopyBlock
          label="200 response body"
          code={`{
  "success": true,
  "status": "SUCCESS",
  "purchased_code": null,
  "units": null,
  "request_id": "req_...",
  "tx_hash": "0x91a3...4f2c"
}`}
        />
      </section>

      <div className="mb-6">
        <X402Playground />
      </div>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8">
        <h2 className="font-black text-slate-900 dark:text-white mb-3">Try it — curl</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-4 max-w-2xl">
          A GET or probing POST with no payment attached returns a valid 402 challenge — the endpoint is always live for discovery, no credential required to see the price. CORS is open on this endpoint (see the live panel above), so this also works straight from browser JS, not just curl.
        </p>
        <CopyBlock
          code={`curl -X POST https://www.abapays.com/api/pay/x402 \\
  -H "Content-Type: application/json" \\
  -d '{"serviceID":"mtn","serviceCategory":"AIRTIME","network":"MTN","billersCode":"08012345678","nairaAmount":1000,"token":"USDT","blockchain":"CELO","wallet_address":"0xYourAgentWallet"}'`}
        />
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-4">
          Full machine-readable spec: <a href="https://abapays.com/openapi.json" target="_blank" rel="noopener noreferrer" className="underline hover:text-emerald-500">openapi.json</a>. For the signed retry that actually settles it, see <Link href="/agents/x402" className="underline hover:text-emerald-500">/agents/x402</Link> or <Link href="/agents/sdk" className="underline hover:text-emerald-500">abapay-sdk</Link>. Every error code this endpoint can return: <Link href="/agents/errors" className="underline hover:text-emerald-500">/agents/errors</Link>.
        </p>
      </section>
    </>
  );
}
