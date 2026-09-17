"use client";

import { useMemo, useState } from "react";
import { Send, Copy, Check, Loader2 } from "lucide-react";

const X402_ENDPOINT = "https://agents.abapays.com/api/pay/x402";

const DEFAULT_BILL = {
  serviceID: "mtn",
  serviceCategory: "AIRTIME",
  network: "MTN",
  billersCode: "08012345678",
  nairaAmount: "1000",
  token: "USDC",
  blockchain: "CELO",
  wallet_address: "0xYourAgentWallet",
};

const FIELD_HINT: Record<string, string> = {
  serviceID: "VTpass service id, e.g. mtn, ikeja-electric",
  serviceCategory: "AIRTIME | DATA | ELECTRICITY | CABLE | BANK | EDUCATION",
  network: "Provider name, e.g. MTN, DSTV",
  billersCode: "Phone / meter / smartcard number",
  nairaAmount: "Bill amount in NGN",
  token: "USDC, USD₮, or USA₮ — an unrecognized value silently falls back to USDC",
  blockchain: "CELO — this rail is Celo-only",
  wallet_address: "The paying wallet",
};

// ⚡ REAL, NOT MOCKED — this POSTs to the actual production endpoint with no X-PAYMENT header,
// which per src/app/api/pay/x402/route.ts always returns a genuine 402 challenge naming the
// live price. Nothing here can settle a payment (that needs a signed EIP-3009 authorization
// this page never asks for) — it's the same safe probe api.md's curl example describes, just
// editable and fired for real instead of copy-pasted into a terminal.
export default function X402Playground() {
  const [fields, setFields] = useState<Record<string, string>>(DEFAULT_BILL);
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const body = useMemo(() => ({
    ...fields,
    nairaAmount: Number(fields.nairaAmount) || 0,
  }), [fields]);
  const bodyJson = JSON.stringify(body, null, 2);

  async function send() {
    setSending(true);
    setResponse(null);
    setStatus(null);
    try {
      const res = await fetch(X402_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyJson,
      });
      setStatus(res.status);
      const data = await res.json();
      setResponse(JSON.stringify(data, null, 2));
    } catch (e) {
      setResponse(`Request failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(false);
    }
  }

  async function copyBody() {
    try {
      await navigator.clipboard.writeText(bodyJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  }

  return (
    <div className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8">
      <h2 className="font-black text-slate-900 dark:text-white mb-1.5">Try it — live</h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-5 max-w-2xl">
        Edit the bill, hit send — a probe against production with no payment attached returns a 402 challenge naming the live price. Nothing here moves money.
      </p>

      <div className="grid lg:grid-cols-2 gap-6">
        <div className="space-y-3">
          {Object.keys(DEFAULT_BILL).map((key) => (
            <div key={key}>
              <label className="text-xs font-bold text-slate-600 dark:text-slate-300 mb-1 block">
                <code className="text-emerald-600 dark:text-emerald-400">{key}</code>
              </label>
              <input
                value={fields[key]}
                onChange={(e) => setFields((f) => ({ ...f, [key]: e.target.value }))}
                placeholder={FIELD_HINT[key]}
                className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white placeholder:text-slate-300 dark:placeholder:text-slate-600"
              />
            </div>
          ))}
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">POST body</label>
            <button onClick={copyBody} className="flex items-center gap-1 text-[10px] font-bold text-slate-400 hover:text-emerald-500">
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="bg-slate-50 dark:bg-black/40 border border-slate-100 dark:border-slate-800/60 rounded-xl p-4 text-xs text-slate-600 dark:text-slate-300 overflow-x-auto max-h-56 mb-3">{bodyJson}</pre>

          <button
            onClick={send}
            disabled={sending}
            className="w-full flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 text-white text-sm font-bold rounded-xl py-2.5 transition-colors"
          >
            {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            {sending ? "Sending…" : "Send to the production endpoint"}
          </button>

          {response && (
            <>
              <div className="flex items-center gap-2 mt-4 mb-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">Response</label>
                {status !== null && (
                  <span className={`text-[10px] font-black px-1.5 py-0.5 rounded ${status === 402 ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"}`}>
                    HTTP {status}
                  </span>
                )}
              </div>
              <pre className="bg-slate-900 dark:bg-black border border-slate-800 rounded-xl p-4 text-xs text-emerald-300 overflow-x-auto max-h-56">{response}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
