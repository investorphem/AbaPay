import 'server-only';
import { LOGO_DATA_URL } from './logoDataUrl';

// ⚡ MCP APPS (SEP-1865) — AbaPay's interactive receipt/history card.
//
// 🔴 WHY THIS EXISTS: the MCP `image` content block (receiptCard.tsx) is a flat PNG baked
// server-side with next/og's Satori renderer — real, but limited: Satori's bundled font is a
// subset that drops ₦/₮ (see receiptCard.tsx's own comment on that), it can't be interactive
// (no "copy tx hash", no live link), and whether it even renders at all depends entirely on
// whether the specific MCP client chooses to display inline images from a tool result — a
// client behavior AbaPay's server has no visibility into and cannot fix from here.
//
// MCP Apps is the actual, OPEN answer: an official MCP extension (shipped as the protocol's
// first extension 2026-01-26, folded into the 2026-07-28 spec) that lets any server — not
// just a first-party Anthropic-partnered connector — ship a real HTML/CSS/JS view, rendered
// by the host in a sandboxed iframe, fed live data over the same JSON-RPC channel every other
// MCP message already uses. This is that view: one generic template, driven entirely by the
// `structuredContent` a tool result attaches (see withCard in mcpTools.ts) — never by
// anything baked in at build time, so it can render pay_bill's receipt, transaction_history's
// paginated statement, check_balance's per-token balances, list_schedules' automations, and
// pay_bill_batch's summary from the exact same file.
//
// 🔴 THE CARD CAN CALL TOOLS BACK — not just display data. transaction_history's Prev/Next,
// check_balance's Refresh, and list_schedules' Cancel buttons all use the spec's own
// "Interactive Updates" pattern (a View sending `tools/call` back through the host, same as
// any other MCP message) — see callServerTool() below. Deliberately NOT extended to
// pay_bill/pay_bill_batch/schedule_bill: those need a PIN, and typing a spending PIN into a
// sandboxed third-party iframe is a different, weaker trust boundary than the human typing it
// directly into Claude's own message box, which is the one this whole codebase is built around
// protecting (escalating lockout, out-of-band spend alerts, rate limiting — see mcpTools.ts).
// cancel_schedule needs no PIN, matching its existing MCP/chat security level, which is why
// it's the one write action this card exposes.
//
// The `content` array the MCP tool call still returns (text, and the existing PNG image for
// clients that never negotiate this extension) is UNCHANGED — this is additive. A host that
// doesn't understand `_meta.ui.resourceUri` just ignores it and falls back to that content,
// exactly as the spec requires ("Tools MUST return meaningful content array even when UI is
// available").

export const MCP_UI_CARD_URI = 'ui://abapay/card';

export const MCP_UI_CARD_RESOURCE = {
  uri: MCP_UI_CARD_URI,
  name: 'AbaPay Card',
  description: 'Interactive receipt / transaction history / batch summary card',
  mimeType: 'text/html;profile=mcp-app',
};

// One template, six views (`structuredContent.view`): 'receipt' | 'history' | 'balance' |
// 'schedules' | 'capabilities' | 'batch'. Vanilla HTML/CSS/JS, no build step and no external
// resources — CSP
// for this resource is therefore left at the spec's restrictive default (no `ui.csp`
// declared), and the logo is inlined as the same base64 PNG constant receiptCard.tsx already
// uses rather than a fetched asset, so nothing here needs a `resourceDomains` allowance either.
//
// Kept in one string constant, not a function — nothing here is build-time-computed; real data
// arrives either via ui/notifications/tool-result (the call that spawned this view) or as the
// direct response to a view-initiated tools/call (Prev/Next/Refresh/Cancel — see
// callServerTool() below), never anything baked in here.
export const MCP_UI_CARD_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AbaPay</title>
<style>
  :root {
    color-scheme: light dark;
    --ab-bg: light-dark(#f8fafc, #0b0b0e);
    --ab-card: light-dark(#ffffff, #15151a);
    --ab-border: light-dark(rgba(15,23,42,0.10), rgba(148,163,184,0.16));
    --ab-muted: light-dark(#64748b, #94a3b8);
    --ab-text: light-dark(#0f172a, #f8fafc);
    --ab-emerald: #10b981;
    --ab-red: #f87171;
    --ab-blue: light-dark(#2563eb, #60a5fa);
    --ab-amber: light-dark(#d97706, #fbbf24);
    --ab-gold: #c9a02b;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
    background: var(--color-background-primary, var(--ab-bg));
    color: var(--color-text-primary, var(--ab-text));
    padding: 14px;
  }
  .card {
    background: var(--color-background-secondary, var(--ab-card));
    border: var(--border-width-regular, 1px) solid var(--color-border-primary, var(--ab-border));
    border-radius: var(--border-radius-lg, 18px);
    padding: 18px;
    box-shadow: var(--shadow-lg, 0 10px 30px -10px rgba(0,0,0,0.25));
    position: relative;
    overflow: hidden;
  }
  /* A thin brand-gradient hairline along the top edge — the one deliberate "premium" flourish,
     restrained enough to work in both themes and never fight the host's own styling. */
  .card::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
    background: linear-gradient(90deg, var(--ab-emerald), var(--ab-gold));
  }
  .fade-in { animation: ab-fade 0.22s ease-out; }
  @keyframes ab-fade { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
  .svc-icon { flex-shrink: 0; opacity: 0.75; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand img { width: 26px; height: 18px; object-fit: contain; }
  .brand span { font-weight: 700; font-size: var(--font-heading-xs-size, 15px); letter-spacing: -0.2px; }
  .chip {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--color-text-secondary, var(--ab-muted));
    border: 1px solid var(--color-border-primary, var(--ab-border));
    border-radius: 999px; padding: 3px 10px;
  }
  .status-row { display: flex; align-items: center; gap: 10px; margin-top: 18px; }
  .status-dot {
    width: 26px; height: 26px; border-radius: 999px; display: flex; align-items: center;
    justify-content: center; flex-shrink: 0;
  }
  .status-text { font-weight: 800; font-size: 15px; }
  .amount-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--color-text-secondary, var(--ab-muted)); margin-top: 16px;
  }
  .amount-value { font-size: 30px; font-weight: 800; margin-top: 2px; line-height: 1.15; }
  .amount-sub { font-size: 13px; color: var(--color-text-secondary, var(--ab-muted)); margin-top: 2px; }
  .details { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--color-border-primary, var(--ab-border)); display: flex; flex-direction: column; gap: 8px; }
  .detail-row { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
  .detail-label { color: var(--color-text-secondary, var(--ab-muted)); font-weight: 600; }
  .detail-value { font-weight: 700; text-align: right; }
  .detail-value.accent { color: var(--ab-emerald); }
  .footer { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--color-border-primary, var(--ab-border)); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .footer span { font-size: 11px; color: var(--color-text-secondary, var(--ab-muted)); }
  .link-btn {
    font-size: 12px; font-weight: 700; color: var(--ab-blue); background: none; border: none;
    padding: 0; cursor: pointer; text-decoration: underline;
  }
  .hist-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-top: 1px solid var(--color-border-primary, var(--ab-border)); }
  .hist-row:first-child { border-top: none; }
  .hist-left { display: flex; flex-direction: column; }
  .hist-service { font-weight: 700; font-size: 13px; display: flex; align-items: center; gap: 6px; }
  .cap-row { padding: 10px 0; border-top: 1px solid var(--color-border-primary, var(--ab-border)); }
  .cap-row:first-child { border-top: none; }
  .cap-title { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13px; }
  .cap-example { font-size: 11px; color: var(--color-text-secondary, var(--ab-muted)); margin-top: 2px; font-style: italic; }
  .cap-badge { font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; border-radius: 999px; padding: 2px 8px; }
  .hist-meta { font-size: 11px; color: var(--color-text-secondary, var(--ab-muted)); margin-top: 1px; }
  .hist-right { display: flex; flex-direction: column; align-items: flex-end; }
  .hist-amount { font-weight: 800; font-size: 13px; }
  .hist-status { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 1px; }
  .loading { padding: 18px 0; text-align: center; color: var(--color-text-secondary, var(--ab-muted)); font-size: 13px; }
  .pager { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--color-border-primary, var(--ab-border)); }
  .pager-label { font-size: 11px; color: var(--color-text-secondary, var(--ab-muted)); font-weight: 700; }
  .link-btn:disabled { opacity: 0.35; cursor: default; text-decoration: none; }
  .cancel-btn { font-size: 11px; font-weight: 800; color: var(--ab-red); background: none; border: 1px solid var(--ab-red); border-radius: 999px; padding: 4px 10px; cursor: pointer; }
  .cancel-btn:disabled { opacity: 0.4; cursor: default; }
  .toast {
    position: fixed; left: 12px; right: 12px; bottom: 12px; background: var(--ab-red); color: #fff;
    padding: 10px 14px; border-radius: 10px; font-size: 12px; font-weight: 700; z-index: 999;
    box-shadow: var(--shadow-md, 0 4px 12px rgba(0,0,0,0.2));
  }
</style>
</head>
<body>
<div id="root" class="card"><div class="loading">Loading AbaPay…</div></div>
<script>
(function () {
  var LOGO = ${JSON.stringify(LOGO_DATA_URL)};
  var nextId = 1;
  var pending = {};

  function send(method, params) {
    var id = nextId++;
    window.parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params }, '*');
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params) {
    window.parent.postMessage({ jsonrpc: '2.0', method: method, params: params }, '*');
  }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.jsonrpc !== '2.0') return;
    if (data.id !== undefined && pending[data.id]) {
      var p = pending[data.id]; delete pending[data.id];
      if (data.error) p.reject(new Error(data.error.message)); else p.resolve(data.result);
      return;
    }
    if (data.method === 'ui/notifications/host-context-changed') applyHostContext(data.params);
    if (data.method === 'ui/notifications/tool-result') render(data.params);
    if (data.method === 'ui/notifications/tool-cancelled') {
      var root = document.getElementById('root');
      if (root) root.innerHTML = '<div class="loading">Cancelled.</div>';
    }
  });

  function applyHostContext(ctx) {
    if (!ctx) return;
    try {
      if (ctx.theme) document.documentElement.style.colorScheme = ctx.theme;
      var vars = ctx.styles && ctx.styles.variables;
      if (vars) {
        for (var k in vars) { if (vars[k]) document.documentElement.style.setProperty(k, vars[k]); }
      }
      var fonts = ctx.styles && ctx.styles.css && ctx.styles.css.fonts;
      if (fonts) {
        var styleTag = document.createElement('style');
        styleTag.textContent = fonts;
        document.head.appendChild(styleTag);
      }
    } catch (e) { /* never let theming break the card */ }
  }

  function openLink(url) { if (url) send('ui/open-link', { url: url }).catch(function () {}); }

  // "Interactive Updates" (spec) — the View calling a real MCP tool through the host, exactly
  // like the agent would, and getting a normal CallToolResult straight back (not via the
  // ui/notifications/tool-result path, which is for host-initiated calls only).
  function callServerTool(name, toolArgs) {
    return send('tools/call', { name: name, arguments: toolArgs || {} });
  }

  function showToast(msg) {
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Real transaction outcomes, not just success — see finalizePayBillResult's own comment on
  // why PENDING/FAILED_VENDING now reach this card at all. FAILED_VENDING gets its own label
  // deliberately distinct from a hard failure: the PAYMENT went through, only delivery didn't,
  // and a refund is already in motion — calling that "Payment Failed" would read as "you lost
  // your money," which isn't true and isn't what result.message says either.
  function statusVisual(status) {
    if (status === 'SUCCESS') return { color: 'var(--ab-emerald)', label: 'Payment Successful', icon: 'check' };
    if (status === 'PENDING') return { color: 'var(--ab-blue)', label: 'Still Confirming', icon: 'clock' };
    if (status === 'FAILED_VENDING') return { color: 'var(--ab-amber)', label: 'Delivery Failed — Refund Pending', icon: 'refund' };
    return { color: 'var(--ab-red)', label: 'Payment Failed', icon: 'alert' };
  }

  // Real inline SVG glyphs (stroke, currentColor) instead of a CSS-border hack — crisper at
  // every size and themeable through the same status color the label already uses.
  function statusIconSvg(icon, color) {
    var paths = {
      check: '<path d="M5 12l4 4 10-10"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
      alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v4"/><circle cx="12" cy="17" r="0.5" fill="currentColor" stroke="none"/>',
      refund: '<path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M4 4v4h4"/>',
    };
    return '<div class="status-dot" style="background:' + color + '22;color:' + color + '">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      (paths[icon] || paths.check) + '</svg></div>';
  }

  // Small per-service glyphs for the "everything AbaPay offers" views (history, schedules,
  // capabilities) — same currentColor/stroke treatment as the status icons above, so a card
  // full of rows reads as one coherent icon set rather than mismatched styles.
  function serviceIconSvg(label) {
    var s = String(label || '').toUpperCase();
    var path =
      /ELECTRIC/.test(s) ? '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>' :
      /DATA/.test(s) ? '<path d="M5 12a7 9 0 0 1 14 0"/><path d="M8.5 15a3.5 4.5 0 0 1 7 0"/><circle cx="12" cy="19" r="1" fill="currentColor" stroke="none"/>' :
      /CABLE|TV/.test(s) ? '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M8 3l4 3 4-3"/>' :
      /EDUCATION|WAEC|JAMB/.test(s) ? '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/>' :
      /BANK|GTBANK|OPAY|TRANSFER/.test(s) ? '<path d="M3 10l9-6 9 6"/><path d="M5 10v9h14v-9"/><path d="M10 19v-6h4v6"/>' :
      /INTERNATIONAL/.test(s) ? '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>' :
      '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 18h4"/>'; // default: phone/airtime
    return '<svg class="svc-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }

  function renderReceipt(sc) {
    var v = statusVisual(sc.status);
    var html = '<div class="row"><div class="brand"><img src="' + LOGO + '" alt="AbaPay"/><span>AbaPay</span></div>' +
      '<div class="chip">' + esc(sc.chain || '') + '</div></div>';
    html += '<div class="status-row">' + statusIconSvg(v.icon, v.color) +
      '<span class="status-text" style="color:' + v.color + '">' + esc(v.label) + '</span></div>';
    html += '<div class="amount-label">Amount Paid</div>' +
      '<div class="amount-value">' + esc(sc.displayAmountNgn) + '</div>' +
      '<div class="amount-sub">' + esc(sc.cryptoCharged) + '</div>';
    html += '<div class="details">';
    html += detailRow('Service', sc.serviceLabel);
    html += detailRow(/electric/i.test(sc.serviceLabel || '') ? 'Meter Number' : 'Account', sc.accountNumber);
    if (sc.customerName) html += detailRow('Name', sc.customerName);
    if (sc.customerAddress) html += detailRow('Address', sc.customerAddress);
    if (sc.purchasedCode) html += detailRow(/electric/i.test(sc.serviceLabel || '') ? 'Token' : 'PIN', sc.purchasedCode, true);
    if (sc.units) html += detailRow('Units', sc.units);
    if (sc.referenceId) html += detailRow('Reference', sc.referenceId);
    html += '</div>';
    var txShort = sc.txHash ? (sc.txHash.slice(0, 10) + '...' + sc.txHash.slice(-8)) : '';
    html += '<div class="footer"><span>' + esc(txShort) + '</span>';
    if (sc.receiptUrl) html += '<button class="link-btn" data-open="' + esc(sc.receiptUrl) + '">View receipt</button>';
    html += '</div>';
    return html;
  }

  function detailRow(label, value, accent) {
    return '<div class="detail-row"><span class="detail-label">' + esc(label) + '</span>' +
      '<span class="detail-value' + (accent ? ' accent' : '') + '">' + esc(value) + '</span></div>';
  }

  // Called both for the initial render and for every Prev/Next click — sc.limit/sc.offset
  // come straight from the tool result each time (server-computed, see callTransactionHistory
  // in mcpTools.ts), so the buttons never need locally-tracked paging state of their own.
  function renderHistory(sc) {
    var html = '<div class="row"><div class="brand"><img src="' + LOGO + '" alt="AbaPay"/><span>AbaPay</span></div>' +
      '<div class="chip">' + esc((sc.wallet || '').slice(0, 6) + '...' + (sc.wallet || '').slice(-4)) + '</div></div>';
    html += '<div class="amount-label" style="margin-top:16px">Recent Activity</div>';
    var rows = sc.rows || [];
    var limit = sc.limit || 10;
    var offset = sc.offset || 0;
    if (rows.length === 0 && offset === 0) {
      html += '<div class="loading">No transactions yet.</div>';
    } else if (rows.length === 0) {
      html += '<div class="loading">No more transactions.</div>';
    } else {
      html += '<div style="margin-top:6px">';
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var color = r.status === 'SUCCESS' ? 'var(--ab-emerald)' : (r.status === 'REFUNDED' ? 'var(--ab-blue)' : 'var(--ab-red)');
        html += '<div class="hist-row"><div class="hist-left"><span class="hist-service">' + serviceIconSvg(r.serviceLabel) + esc(r.serviceLabel) + '</span>' +
          '<span class="hist-meta">' + esc(r.date) + ' &middot; ' + esc(r.accountNumber) + '</span></div>' +
          '<div class="hist-right"><span class="hist-amount">' + esc(r.displayAmountNgn) + '</span>' +
          '<span class="hist-status" style="color:' + color + '">' + esc(r.status) + '</span></div></div>';
      }
      html += '</div>';
    }
    var prevArgs = esc(JSON.stringify({ limit: limit, offset: Math.max(0, offset - limit) }));
    var nextArgs = esc(JSON.stringify({ limit: limit, offset: offset + limit }));
    html += '<div class="pager">' +
      '<button class="link-btn" data-call="transaction_history" data-args="' + prevArgs + '"' + (offset <= 0 ? ' disabled' : '') + '>&larr; Prev</button>' +
      '<span class="pager-label">' + (rows.length ? (offset + 1) + '–' + (offset + rows.length) : '—') + '</span>' +
      '<button class="link-btn" data-call="transaction_history" data-args="' + nextArgs + '"' + (!sc.hasMore ? ' disabled' : '') + '>Next &rarr;</button>' +
      '</div>';
    return html;
  }

  function renderBalance(sc) {
    var html = '<div class="row"><div class="brand"><img src="' + LOGO + '" alt="AbaPay"/><span>AbaPay</span></div>' +
      '<div class="chip">' + esc(sc.chain || '') + '</div></div>';
    html += '<div class="amount-label" style="margin-top:16px">Wallet</div>' +
      '<div class="amount-sub">' + esc(sc.wallet) + '</div>';
    html += '<div class="details">';
    var toks = sc.tokens || [];
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      var label = t.symbol + (t.symbol === sc.defaultToken ? ' (default)' : '');
      var value = t.balance + ' · limit ' + (t.limit === null || t.limit === undefined ? 'unavailable' : t.limit);
      html += detailRow(label, value);
    }
    html += '</div>';
    var refreshArgs = esc(JSON.stringify({ chain: sc.chain }));
    html += '<div class="footer"><span></span><button class="link-btn" data-call="check_balance" data-args="' + refreshArgs + '">Refresh</button></div>';
    return html;
  }

  function renderSchedules(sc) {
    var html = '<div class="row"><div class="brand"><img src="' + LOGO + '" alt="AbaPay"/><span>AbaPay</span></div>' +
      '<div class="chip">' + esc((sc.schedules || []).length + ' active') + '</div></div>';
    html += '<div class="amount-label" style="margin-top:16px">Automations</div>';
    var list = sc.schedules || [];
    if (list.length === 0) {
      html += '<div class="loading">No active schedules.</div>';
    } else {
      html += '<div style="margin-top:6px">';
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        var cancelArgs = esc(JSON.stringify({ id: s.id }));
        html += '<div class="hist-row"><div class="hist-left"><span class="hist-service">' + serviceIconSvg(s.service) + esc(s.provider) + ' ' + esc(s.service) + '</span>' +
          '<span class="hist-meta">' + esc(s.accountNumber) + ' &middot; ' + esc(s.when) + ' &middot; ' + (s.autoExecute ? 'auto-pays' : 'notify-only') + '</span></div>' +
          '<button class="cancel-btn" data-call="cancel_schedule" data-args="' + cancelArgs + '" data-mode="refresh-schedules">Cancel</button></div>';
      }
      html += '</div>';
    }
    return html;
  }

  // "Everything AbaPay offers, on the card" — the services overview, sourced from the exact
  // same CAPABILITIES list (and live kill-switch state) describe_capabilities' own text answer
  // uses (see getCapabilitiesForCard in capabilities.ts), so this can never quietly say
  // something's available when the text/chat answer would say it's paused, or vice versa.
  function renderCapabilities(sc) {
    var html = '<div class="row"><div class="brand"><img src="' + LOGO + '" alt="AbaPay"/><span>AbaPay</span></div>' +
      '<div class="chip">Services</div></div>';
    var entries = sc.entries || [];
    var here = entries.filter(function (e) { return e.supportedInChat; });
    var appOnly = entries.filter(function (e) { return !e.supportedInChat; });

    html += '<div class="amount-label" style="margin-top:16px">Right here, over MCP</div>';
    for (var i = 0; i < here.length; i++) {
      html += capRow(here[i], false);
    }
    if (appOnly.length) {
      html += '<div class="amount-label" style="margin-top:16px">In the AbaPay app only</div>';
      for (var j = 0; j < appOnly.length; j++) {
        html += capRow(appOnly[j], true);
      }
    }
    return html;
  }

  function capRow(e, appOnly) {
    var badge = e.paused
      ? '<span class="cap-badge" style="background:var(--ab-red)22;color:var(--ab-red)">Paused</span>'
      : appOnly
      ? '<span class="cap-badge" style="background:var(--color-background-tertiary, var(--ab-border));color:var(--color-text-secondary, var(--ab-muted))">App only</span>'
      : '<span class="cap-badge" style="background:var(--ab-emerald)22;color:var(--ab-emerald)">Available</span>';
    return '<div class="cap-row"><div class="row"><span class="cap-title">' + serviceIconSvg(e.id) + esc(e.label) + '</span>' + badge + '</div>' +
      (e.example ? '<div class="cap-example">"' + esc(e.example) + '"</div>' : '') +
      (e.notes ? '<div class="cap-example" style="font-style:normal">' + esc(e.notes) + '</div>' : '') +
      '</div>';
  }

  function renderBatch(sc) {
    var html = '<div class="row"><div class="brand"><img src="' + LOGO + '" alt="AbaPay"/><span>AbaPay</span></div>' +
      '<div class="chip">' + esc(sc.okCount + '/' + sc.totalCount) + '</div></div>';
    html += '<div class="amount-label" style="margin-top:16px">Batch Total</div>' +
      '<div class="amount-value">' + esc(sc.totalDisplay || ('NGN ' + Number(sc.totalNgn || 0).toLocaleString())) + '</div>';
    var recips = sc.recipients || [];
    html += '<div style="margin-top:6px">';
    for (var i = 0; i < recips.length; i++) {
      var r = recips[i];
      var color = r.status === 'OK' ? 'var(--ab-emerald)' : (r.status === 'PENDING' ? 'var(--ab-blue)' : 'var(--ab-red)');
      html += '<div class="hist-row"><div class="hist-left"><span class="hist-service">' + serviceIconSvg(r.service) + esc(r.provider) + ' ' + esc(r.service) + '</span>' +
        '<span class="hist-meta">' + esc(r.accountNumber) + '</span></div>' +
        '<div class="hist-right"><span class="hist-amount">' + esc(r.displayAmountNgn) + '</span>' +
        '<span class="hist-status" style="color:' + color + '">' + esc(r.status) + '</span></div></div>';
    }
    html += '</div>';
    return html;
  }

  function render(result) {
    var root = document.getElementById('root');
    if (!root) return;
    var sc = result && result.structuredContent;
    var inner;
    if (!sc) {
      var fallback = (result && result.content && result.content[0] && result.content[0].text) || 'No data.';
      inner = '<div class="loading">' + esc(fallback) + '</div>';
    } else if (sc.view === 'receipt') inner = renderReceipt(sc);
    else if (sc.view === 'history') inner = renderHistory(sc);
    else if (sc.view === 'batch') inner = renderBatch(sc);
    else if (sc.view === 'balance') inner = renderBalance(sc);
    else if (sc.view === 'schedules') inner = renderSchedules(sc);
    else if (sc.view === 'capabilities') inner = renderCapabilities(sc);
    else inner = '<div class="loading">Unrecognized card type.</div>';

    // Wrapped in a freshly-inserted element (not the persistent #root itself) so the fade-in
    // keyframe actually replays on every re-render — Prev/Next, Refresh, Cancel — not just the
    // very first paint; a CSS animation class doesn't retrigger on an element that already
    // existed, only on one that's newly inserted into the DOM.
    root.innerHTML = '<div class="fade-in">' + inner + '</div>';
    wireActions(root);
    reportSize();
  }

  // Delegated once per render rather than once per button — root.innerHTML is fully replaced
  // on every render() call, so any listeners attached to elements inside it are already gone;
  // re-wiring here (not at load time) is what makes the re-rendered Prev/Next/Refresh/Cancel
  // buttons work after every call, not just the first paint.
  function wireActions(root) {
    var openBtns = root.querySelectorAll('[data-open]');
    for (var i = 0; i < openBtns.length; i++) {
      (function (el) { el.addEventListener('click', function () { openLink(el.getAttribute('data-open')); }); })(openBtns[i]);
    }

    var callBtns = root.querySelectorAll('[data-call]');
    for (var j = 0; j < callBtns.length; j++) {
      (function (el) {
        el.addEventListener('click', function () {
          if (el.disabled) return;
          var toolName = el.getAttribute('data-call');
          var mode = el.getAttribute('data-mode') || 'rerender';
          var toolArgs = {};
          try { toolArgs = JSON.parse(el.getAttribute('data-args') || '{}'); } catch (e) { /* malformed — call with no args */ }

          var originalLabel = el.textContent;
          el.disabled = true;
          el.textContent = '…';

          callServerTool(toolName, toolArgs).then(function (result) {
            if (result && result.isError) {
              var msg = (result.content && result.content[0] && result.content[0].text) || 'That failed.';
              showToast(msg);
              el.disabled = false;
              el.textContent = originalLabel;
              return;
            }
            if (mode === 'refresh-schedules') {
              return callServerTool('list_schedules', {}).then(function (fresh) { render(fresh); });
            }
            render(result);
          }).catch(function () {
            showToast('Could not reach AbaPay — try again.');
            el.disabled = false;
            el.textContent = originalLabel;
          });
        });
      })(callBtns[j]);
    }
  }

  var lastSize = '';
  function reportSize() {
    var w = document.body.scrollWidth, h = document.body.scrollHeight;
    var key = w + 'x' + h;
    if (key === lastSize) return;
    lastSize = key;
    notify('ui/notifications/size-changed', { width: w, height: h });
  }
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(reportSize).observe(document.body);
  } else {
    setInterval(reportSize, 500);
  }

  send('ui/initialize', {
    capabilities: {},
    clientInfo: { name: 'abapay-card', version: '1.0.0' },
    protocolVersion: '2026-01-26',
    appCapabilities: { availableDisplayModes: ['inline'] },
  }).then(function (result) {
    applyHostContext(result && result.hostContext);
    notify('ui/notifications/initialized', {});
    reportSize();
  }).catch(function () { /* host predates ui/initialize support — nothing to do */ });
})();
</script>
</body>
</html>`;
