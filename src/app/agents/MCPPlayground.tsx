"use client";

import { useMemo, useState } from "react";
import { Send, Copy, Check, Loader2, ShieldAlert } from "lucide-react";
import { TOOLS } from "./toolSchemas";

const MCP_ENDPOINT = "https://agents.abapays.com/api/mcp";

// ⚡ THIS ACTUALLY CALLS THE REAL SERVER — not a mock, not a canned response. Read-only tools
// (describe_capabilities, check_balance, list_plans, list_international_options,
// transaction_history, list_schedules) are safe to fire straight from the browser: no state
// changes, and check_balance/transaction_history/list_schedules just need a real api_key to
// return real data instead of the "unauthorized" they'll return with none. Money-moving tools
// (pay_bill, pay_bill_batch, schedule_bill, cancel_schedule) are deliberately NOT wired to a
// Send button here — see the note rendered instead. This call is same-origin (this page and
// the endpoint both resolve on agents.abapays.com), but /api/mcp still opens CORS narrowly in
// middleware.ts's CORS_API_PATHS since third-party agents call it cross-origin too.
export default function MCPPlayground() {
  const [toolName, setToolName] = useState(TOOLS[0].name);
  const tool = useMemo(() => TOOLS.find((t) => t.name === toolName)!, [toolName]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function setVal(name: string, v: string) {
    setValues((prev) => ({ ...prev, [name]: v }));
  }

  const args = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const p of tool.params) {
      const raw = values[p.name];
      if (raw === undefined || raw === "") continue;
      out[p.name] = p.type === "number" ? Number(raw) : raw;
    }
    return out;
  }, [tool, values]);

  const requestBody = useMemo(
    () => ({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool.name, arguments: args },
    }),
    [tool, args]
  );

  const requestJson = JSON.stringify(requestBody, null, 2);

  async function send() {
    setSending(true);
    setResponse(null);
    try {
      const res = await fetch(MCP_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestJson,
      });
      const data = await res.json();
      setResponse(JSON.stringify(data, null, 2));
    } catch (e) {
      setResponse(`Request failed: ${e instanceof Error ? e.message : String(e)}\n\nMost likely your browser or an extension blocked the cross-origin request — the request body above is still exactly what would be sent.`);
    } finally {
      setSending(false);
    }
  }

  async function copyRequest() {
    try {
      await navigator.clipboard.writeText(requestJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  }

  return (
    <div className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8">
      <h2 className="font-black text-slate-900 dark:text-white mb-1.5">Try it — live</h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-5 max-w-2xl">
        Pick a tool, fill in real values, and this calls the actual production MCP server — not a mock. Read-only tools send for real; anything that moves money or state shows the exact request instead of a Send button.
      </p>

      <div className="grid lg:grid-cols-2 gap-6">
        <div>
          <label className="block text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-2">Tool</label>
          <select
            value={toolName}
            onChange={(e) => { setToolName(e.target.value); setValues({}); setResponse(null); }}
            className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2.5 text-sm font-bold text-slate-900 dark:text-white mb-5"
          >
            {TOOLS.map((t) => (
              <option key={t.name} value={t.name}>{t.name}</option>
            ))}
          </select>

          {tool.params.length === 0 ? (
            <p className="text-xs text-slate-400 dark:text-slate-500">This tool takes no parameters.</p>
          ) : (
            <div className="space-y-3">
              {tool.params.map((p) => (
                <div key={p.name}>
                  <label className="flex items-center gap-1.5 text-xs font-bold text-slate-600 dark:text-slate-300 mb-1">
                    <code className="text-emerald-600 dark:text-emerald-400">{p.name}</code>
                    {p.required && <span className="text-red-500 text-[10px]">*required</span>}
                  </label>
                  {p.enum ? (
                    <select
                      value={values[p.name] || ""}
                      onChange={(e) => setVal(p.name, e.target.value)}
                      className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white"
                    >
                      <option value="">—</option>
                      {p.enum.map((e) => <option key={e} value={e}>{e}</option>)}
                    </select>
                  ) : (
                    <input
                      type={p.type === "number" ? "number" : "text"}
                      value={values[p.name] || ""}
                      onChange={(e) => setVal(p.name, e.target.value)}
                      placeholder={p.description}
                      className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white placeholder:text-slate-300 dark:placeholder:text-slate-600"
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">Request body</label>
            <button onClick={copyRequest} className="flex items-center gap-1 text-[10px] font-bold text-slate-400 hover:text-emerald-500">
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="bg-slate-50 dark:bg-black/40 border border-slate-100 dark:border-slate-800/60 rounded-xl p-4 text-xs text-slate-600 dark:text-slate-300 overflow-x-auto max-h-64 mb-3">{requestJson}</pre>

          {tool.access === "read" ? (
            <button
              onClick={send}
              disabled={sending}
              className="w-full flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 text-white text-sm font-bold rounded-xl py-2.5 transition-colors"
            >
              {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
              {sending ? "Sending…" : "Send — real server, real response"}
            </button>
          ) : (
            <div className="flex items-start gap-2.5 bg-amber-50 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-900/30 rounded-xl p-3.5">
              <ShieldAlert size={16} className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                This tool moves money or changes state, so this page won&apos;t send it for you. Copy the request above into your own agent — same shape, real endpoint.
              </p>
            </div>
          )}

          {response && (
            <>
              <label className="block text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mt-4 mb-2">Response</label>
              <pre className="bg-slate-900 dark:bg-black border border-slate-800 rounded-xl p-4 text-xs text-emerald-300 overflow-x-auto max-h-64">{response}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
