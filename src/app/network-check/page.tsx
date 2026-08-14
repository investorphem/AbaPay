"use client";

// ⚡ /network-check — "IS IT MY NETWORK, OR IS IT ABAPAY?"
//
// AbaPay's own domain being reachable proves nothing: the connect flow depends on several
// THIRD-PARTY hosts, and some Nigerian mobile networks (MTN most reported) filter them.
// When that happens the failure is silent — a blocked WebSocket never errors, it just never
// opens — so users conclude the app is broken.
//
// This page tests each dependency from the user's own network and names the ones that fail.
// That gives the user an immediate answer, and gives us (and any complaint to the carrier or
// the NCC) the exact hostnames rather than "crypto doesn't work on MTN".

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, XCircle, Loader2, ShieldCheck, Copy, RefreshCw } from "lucide-react";
import { CONNECT_DEPENDENCY_HOSTS, looksLikeRealInjectedWallet, isMiniPayBrowser } from "@/lib/walletEnv";

type Status = "pending" | "ok" | "blocked";

type Result = {
  label: string;
  url: string;
  why: string;
  critical: boolean;
  status: Status;
  detail: string;
  ms: number;
};

const PROBE_TIMEOUT_MS = 8000;

// A blocked host and a slow host look the same for a while, so everything is raced against
// a manual AbortController — not AbortSignal.timeout(), which older in-app webviews
// (exactly the browsers our users are on) don't implement.
function probeHttp(url: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, detail: "timed out — no response" });
    }, PROBE_TIMEOUT_MS);

    // `no-cors` gives an opaque response we can't read, but that's fine: we only care
    // whether the connection was allowed to happen at all. A filtered host rejects.
    fetch(url, { mode: "no-cors", cache: "no-store", signal: controller.signal })
      .then(() => {
        clearTimeout(timer);
        resolve({ ok: true, detail: "reachable" });
      })
      .catch((err) => {
        clearTimeout(timer);
        if (controller.signal.aborted) return;
        resolve({ ok: false, detail: `refused (${String(err?.message || err).slice(0, 60)})` });
      });
  });
}

function probeWebSocket(url: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      try { socket?.close(); } catch { /* already gone */ }
      resolve({ ok, detail });
    };

    const timer = setTimeout(
      () => done(false, "timed out — the socket never opened (typical of a filtered host)"),
      PROBE_TIMEOUT_MS,
    );

    let socket: WebSocket | null = null;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      clearTimeout(timer);
      return done(false, `could not open (${String((err as any)?.message || err).slice(0, 60)})`);
    }

    socket.onopen = () => { clearTimeout(timer); done(true, "socket opened"); };
    socket.onerror = () => { clearTimeout(timer); done(false, "connection error — host unreachable or filtered"); };
    socket.onclose = (ev) => {
      clearTimeout(timer);
      // The relay may close us immediately (we send no real handshake) — but a close that
      // carries a server-supplied code still proves we REACHED it. 1006 is an abnormal
      // closure with no close frame, i.e. we never got there.
      if (ev.code && ev.code !== 1006) done(true, `reached (closed with code ${ev.code})`);
      else done(false, "closed abnormally — host unreachable or filtered");
    };
  });
}

export default function NetworkCheckPage() {
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [env, setEnv] = useState<{ miniPay: boolean; injected: boolean }>({ miniPay: false, injected: false });

  const run = useCallback(async () => {
    setRunning(true);
    setCopied(false);

    const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";
    const initial: Result[] = CONNECT_DEPENDENCY_HOSTS.map((h) => ({
      label: h.label,
      url: h.url,
      why: h.why,
      critical: h.critical,
      status: "pending",
      detail: "checking…",
      ms: 0,
    }));
    setResults(initial);

    await Promise.all(
      CONNECT_DEPENDENCY_HOSTS.map(async (host, i) => {
        const started = Date.now();
        // Probe the relay exactly the way the app does, project id and all.
        const target =
          host.kind === "websocket" && projectId
            ? `${host.url}${host.url.includes("?") ? "&" : "/?"}projectId=${projectId}`
            : host.url;

        const outcome = host.kind === "websocket" ? await probeWebSocket(target) : await probeHttp(target);
        const ms = Date.now() - started;

        setResults((prev) => {
          const next = [...prev];
          next[i] = { ...next[i], status: outcome.ok ? "ok" : "blocked", detail: outcome.detail, ms };
          return next;
        });
      }),
    );

    setRunning(false);
  }, []);

  useEffect(() => {
    setEnv({ miniPay: isMiniPayBrowser(), injected: looksLikeRealInjectedWallet() });
    void run();
  }, [run]);

  const blockedCritical = results.filter((r) => r.status === "blocked" && r.critical);
  const finished = results.length > 0 && results.every((r) => r.status !== "pending");

  const copyReport = async () => {
    const report = [
      `AbaPay network check — ${new Date().toISOString()}`,
      `MiniPay: ${env.miniPay} | injected wallet: ${env.injected}`,
      `UA: ${typeof navigator !== "undefined" ? navigator.userAgent : "n/a"}`,
      "",
      ...results.map((r) => `${r.status === "ok" ? "OK     " : "BLOCKED"}  ${r.url}  (${r.ms}ms) — ${r.detail}`),
    ].join("\n");

    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 dark:bg-[#0b0b0e] px-4 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <Link href="/" className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">
          ← Back to AbaPay
        </Link>

        <h1 className="mt-4 text-2xl font-black text-slate-900 dark:text-white">Network check</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
          If the Connect button does nothing, it is usually your mobile network blocking a service
          AbaPay needs — not AbaPay itself. This checks each one from your connection.
        </p>

        {finished && (
          <div
            className={`mt-6 rounded-2xl border p-4 ${
              blockedCritical.length
                ? "border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/20"
                : "border-emerald-300 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-900/20"
            }`}
          >
            {blockedCritical.length ? (
              <>
                <p className="text-sm font-black text-amber-900 dark:text-amber-200">
                  Your network is blocking {blockedCritical.length} service
                  {blockedCritical.length > 1 ? "s" : ""} AbaPay needs.
                </p>
                <p className="mt-2 text-xs text-amber-900/90 dark:text-amber-200/90 leading-relaxed">
                  Open AbaPay inside <strong>MiniPay</strong> — it connects your wallet directly and needs
                  none of the blocked services. A VPN or a different network also works.
                </p>
              </>
            ) : (
              <p className="text-sm font-black text-emerald-900 dark:text-emerald-200">
                Everything AbaPay needs is reachable on this network.
              </p>
            )}
          </div>
        )}

        <div className="mt-6 space-y-3">
          {results.map((r) => (
            <div
              key={r.url}
              className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111114] p-4 shadow-sm"
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 shrink-0">
                  {r.status === "pending" && <Loader2 size={16} className="animate-spin text-slate-400" />}
                  {r.status === "ok" && <CheckCircle2 size={16} className="text-emerald-500" />}
                  {r.status === "blocked" && <XCircle size={16} className="text-amber-500" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-black text-slate-900 dark:text-white">{r.label}</span>
                    {!r.critical && (
                      <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-slate-500">
                        optional
                      </span>
                    )}
                  </div>
                  <p className="mt-1 break-all text-[11px] text-slate-500 dark:text-slate-400">{r.url}</p>
                  <p className="mt-1 text-[11px] text-slate-600 dark:text-slate-400">{r.why}</p>
                  <p
                    className={`mt-1.5 text-[11px] font-bold ${
                      r.status === "blocked" ? "text-amber-600 dark:text-amber-400" : "text-slate-500"
                    }`}
                  >
                    {r.detail}
                    {r.status !== "pending" && ` · ${r.ms}ms`}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            onClick={() => void run()}
            disabled={running}
            className="flex items-center gap-2 rounded-xl border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50 dark:bg-emerald-900/20 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-400 disabled:opacity-50"
          >
            {running ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {running ? "Checking" : "Run again"}
          </button>

          <button
            onClick={() => void copyReport()}
            disabled={!finished}
            className="flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111114] px-4 py-2 text-[10px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 disabled:opacity-50"
          >
            <Copy size={12} />
            {copied ? "Copied" : "Copy report"}
          </button>
        </div>

        <p className="mt-6 flex items-start gap-2 text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
          <ShieldCheck size={14} className="mt-0.5 shrink-0" />
          This page only checks whether these addresses answer. It sends no personal data, and it
          cannot see or touch your wallet.
        </p>
      </div>
    </main>
  );
}
