import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { resolveMcpIdentity } from '@/lib/deai/mcpAuth';
import { checkPinAllowed, recordPinFailure, clearPinFailures } from '@/lib/deai/pinSecurity';
import { verifyPin } from '@/utils/pinSecurity';
import { getClient, createAuthCode } from '@/lib/deai/mcpOAuth';

// ⚡ THE AUTHORIZATION ENDPOINT — the one page a human ever sees in this whole flow, and the
// only place an OAuth token can be born. Everything downstream (the token endpoint, every
// future tool call in every future conversation) traces back to a real person standing here
// and proving, with their api_key AND their PIN, that this connector may act for them.
//
// 🔴 THE OPEN-REDIRECT RULE — the single most important thing in this file:
// `redirect_uri` is validated against the client's REGISTERED list BEFORE anything is
// rendered, and a failure renders a plain error PAGE. It must never redirect to report the
// problem, because redirecting to an unvalidated URI is precisely the vulnerability: an
// attacker registers nothing, points redirect_uri at their own server, and harvests the
// authorization code out of the query string. Errors that happen BEFORE the redirect_uri is
// proven good are shown on our own page, full stop.
//
// The page is deliberately a hand-rendered, fully self-contained HTML string — inline
// <style>, no scripts, no fonts, no images, nothing external. That satisfies the app's CSP
// without exception, and means this page cannot be broken by anything else in the app.

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://abapays.com';

interface OAuthParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
  scope: string;
}

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlResponse(body: string, status = 200) {
  return new NextResponse(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // An authorization page must never sit in a cache — it is per-user and single-purpose.
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
    },
  });
}

// Brand colors match the main app's header exactly (src/app/page.tsx: the "AbaPay." wordmark
// and its emerald accent dot) — this page used to run its own unrelated blue theme, which is
// exactly why it didn't read as AbaPay at all despite being the one page in the whole OAuth
// flow a real person actually looks at.
const STYLE = `
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    padding:24px;background:#0b0f14;color:#e2e8f0;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  .card{width:100%;max-width:420px;background:#111114;border:1px solid #1f2937;
    border-radius:28px;padding:32px;box-shadow:0 20px 60px -20px rgba(16,185,129,.15)}
  .brandRow{display:flex;align-items:center;gap:10px;margin:0 0 22px}
  .brandRow img{height:34px;width:auto;display:block}
  .brandRow span{font-size:19px;font-weight:900;letter-spacing:-.01em;color:#f8fafc}
  .brandRow .dot{color:#10b981}
  h1{font-size:20px;line-height:1.35;margin:0 0 8px;color:#f8fafc;font-weight:800}
  .sub{font-size:14px;line-height:1.55;color:#94a3b8;margin:0 0 22px}
  label{display:block;font-size:11px;font-weight:800;text-transform:uppercase;
    letter-spacing:.06em;color:#64748b;margin:0 0 7px}
  input{width:100%;padding:13px 14px;margin:0 0 16px;border-radius:12px;
    border:1px solid #27272a;background:#0b0f14;color:#f1f5f9;font-size:15px;
    font-family:inherit}
  input::placeholder{color:#475569}
  input:focus{outline:none;border-color:#10b981;box-shadow:0 0 0 3px rgba(16,185,129,.15)}
  button{width:100%;padding:14px;border:0;border-radius:12px;background:#10b981;color:#022c22;
    font-size:15px;font-weight:800;cursor:pointer;font-family:inherit;letter-spacing:.01em}
  button:hover{background:#059669}
  button:active{transform:scale(.99)}
  .err{background:#2a0e0e;border:1px solid #7f1d1d;color:#fecaca;padding:12px 14px;
    border-radius:12px;font-size:13.5px;line-height:1.5;margin:0 0 18px;white-space:pre-wrap}
  .note{margin:20px 0 0;font-size:12.5px;line-height:1.65;color:#64748b;
    border-top:1px solid #1f2937;padding-top:18px}
  .note strong{color:#a1a1aa}
  a{color:#10b981;text-decoration:none}
  a:hover{text-decoration:underline}
  code{background:#0b0f14;border:1px solid #1f2937;padding:1px 6px;border-radius:5px;font-size:12px}
`;

// The logo is a same-origin request to AbaPay's own static asset (/logo.png), so it's covered
// by the app's existing CSP (img-src 'self' ...) exactly like every other page — this doesn't
// weaken the "no external dependency" property the hand-rendered HTML was built for, since
// "external" there meant third-party CDNs/fonts/scripts, not the app's own domain.
const BRAND_ROW = `<div class="brandRow"><img src="${APP_URL}/logo.png" alt="AbaPay"><span>AbaPay<span class="dot">.</span></span></div>`;

function page(title: string, inner: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<link rel="icon" href="${APP_URL}/logo.png">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><div class="card">${inner}</div></body></html>`;
}

/** Error page — used for every failure that happens BEFORE redirect_uri is proven valid. */
function errorPage(heading: string, detail: string, status = 400) {
  return htmlResponse(
    page(
      'AbaPay — authorization error',
      `${BRAND_ROW}
       <h1>${esc(heading)}</h1>
       <p class="sub">${esc(detail)}</p>
       <p class="note">Nothing was authorized and no access was granted. Close this window and
       try connecting again from your MCP client. If it keeps failing, open
       <a href="${esc(APP_URL)}">${esc(APP_URL)}</a> and check Agent Hub → MCP.</p>`
    ),
    status
  );
}

/** The consent + credentials form. Every OAuth param rides along as a hidden field so the
 *  POST can re-validate them from scratch rather than trusting a session. */
function consentPage(p: OAuthParams, clientName: string | null, error?: string) {
  const hidden = (['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope'] as const)
    .map((k) => `<input type="hidden" name="${k}" value="${esc(p[k])}">`)
    .join('');

  const who = clientName ? esc(clientName) : 'this MCP client';

  return htmlResponse(
    page(
      `Authorize ${clientName || 'MCP client'} — AbaPay`,
      `${BRAND_ROW}
       <h1>Authorize ${who} to access your AbaPay agent</h1>
       <p class="sub">Sign in with the MCP API key and PIN you created in the AbaPay app under
       Agent Hub → MCP. You only have to do this once — after this, ${who} stays connected.</p>
       ${error ? `<div class="err">${esc(error)}</div>` : ''}
       <form method="post" action="/api/oauth/authorize" autocomplete="off">
         ${hidden}
         <label for="api_key">AbaPay MCP API key</label>
         <input id="api_key" name="api_key" type="password" placeholder="aba_mcp_…" required
           autocomplete="off" spellcheck="false">
         <label for="pin">PIN</label>
         <input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,6}"
           placeholder="••••" required autocomplete="off" maxlength="6">
         <button type="submit">Authorize</button>
       </form>
       <p class="note"><strong>Your PIN is still required for every payment.</strong>
       Connecting here does not let ${who} spend on its own — it confirms who you are so you
       stop having to re-enter your API key in every new conversation. Each individual
       <code>pay_bill</code> call still asks for your PIN, and can never exceed the on-chain
       allowance you set in the app.</p>`
    )
  );
}

/** Pull the OAuth params out of a query string or a posted form, identically. */
function readParams(src: URLSearchParams | FormData): OAuthParams {
  const g = (k: string) => String((src as any).get(k) || '').trim();
  return {
    response_type: g('response_type'),
    client_id: g('client_id'),
    redirect_uri: g('redirect_uri'),
    code_challenge: g('code_challenge'),
    code_challenge_method: g('code_challenge_method'),
    state: g('state'),
    scope: g('scope'),
  };
}

type ValidationResult =
  | { ok: true; clientName: string | null }
  | { ok: false; response: NextResponse };

/**
 * Validate every OAuth parameter. Order matters: the client and its registered redirect_uri
 * are established FIRST, so that by the time we consider anything else we already know the
 * only URI we would ever redirect to is one the client itself registered.
 */
async function validate(p: OAuthParams): Promise<ValidationResult> {
  if (p.response_type !== 'code') {
    return { ok: false, response: errorPage('Unsupported request', 'Only response_type=code is supported.') };
  }
  if (!p.client_id) {
    return { ok: false, response: errorPage('Missing client', 'No client_id was supplied.') };
  }

  const client = await getClient(p.client_id);
  if (!client) {
    return { ok: false, response: errorPage('Unknown client', 'That client_id is not registered with AbaPay.') };
  }

  // 🔒 EXACT string match against the registered list — no prefix matching, no "same origin
  // is close enough". Prefix/substring matching is how real open redirects get shipped:
  // "https://good.example/cb" would happily match "https://good.example/cb.evil.com".
  const uris = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
  if (!p.redirect_uri || !uris.includes(p.redirect_uri)) {
    return {
      ok: false,
      response: errorPage(
        'Invalid redirect URI',
        'The redirect_uri does not exactly match one registered by this client. For your safety AbaPay will not redirect there.'
      ),
    };
  }

  if (!p.code_challenge || p.code_challenge_method !== 'S256') {
    return {
      ok: false,
      response: errorPage('PKCE required', 'This authorization server requires PKCE with code_challenge_method=S256.'),
    };
  }

  return { ok: true, clientName: client.client_name };
}

export async function GET(req: Request) {
  const limited = await enforceRateLimit(req, 'oauth-authorize', 40, 300);
  if (limited) return limited;

  const p = readParams(new URL(req.url).searchParams);
  const v = await validate(p);
  if (!v.ok) return v.response;

  return consentPage(p, v.clientName);
}

export async function POST(req: Request) {
  // Tighter than the GET: this is where PINs are checked. The per-identity escalating
  // lockout in pinSecurity.ts is the real defence (it survives across IPs and sessions);
  // this just keeps a single source from hammering the endpoint at all.
  const limited = await enforceRateLimit(req, 'oauth-authorize-submit', 15, 300);
  if (limited) return limited;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return errorPage('Invalid request', 'The authorization form could not be read.');
  }

  const p = readParams(form);

  // Re-validated from scratch on every POST — the hidden fields are attacker-controllable
  // input just like the query string was, and are trusted exactly as little.
  const v = await validate(p);
  if (!v.ok) return v.response;

  const apiKey = String(form.get('api_key') || '').trim();
  const pin = String(form.get('pin') || '').trim();

  // One generic message for every credential failure. Telling the user WHICH half was wrong
  // would tell an attacker holding a stolen api_key that they have a valid one and only need
  // the PIN — that's a free oracle we don't have to hand out.
  const GENERIC = 'Invalid API key or PIN. Check both and try again.';

  if (!apiKey || !pin) return consentPage(p, v.clientName, GENERIC);

  const identity = await resolveMcpIdentity(apiKey);
  if (!identity) return consentPage(p, v.clientName, GENERIC);

  // 🔐 Exactly the same PIN gate every other channel uses — the counter lives on the
  // agent_links row, so attempts made here and attempts made over Telegram or a direct MCP
  // pay_bill all count toward the same lockout. There is no fresh budget of guesses to be
  // had by switching to this page.
  const gate = await checkPinAllowed(identity.id);
  if (!gate.allowed) {
    return consentPage(p, v.clientName, stripMd(gate.message || 'Locked — too many incorrect PINs.'));
  }

  if (!verifyPin(pin, identity.pin_hash)) {
    const fail = await recordPinFailure(identity.id, p.client_id, 'MCP');
    // recordPinFailure's message names the attempts remaining, which is only meaningful once
    // we know the api_key was right — so it's appended to, not substituted for, the generic
    // message. An attacker with a wrong api_key never reaches this line at all.
    return consentPage(p, v.clientName, `${GENERIC}${fail.message ? `\n${stripMd(fail.message)}` : ''}`);
  }

  await clearPinFailures(identity.id);

  const code = await createAuthCode({
    client_id: p.client_id,
    redirect_uri: p.redirect_uri,
    code_challenge: p.code_challenge,
    code_challenge_method: 'S256',
    agent_link_id: identity.id,
  });

  if (!code) {
    return errorPage('Could not complete authorization', 'Something went wrong issuing the authorization code. Please try again.', 500);
  }

  // Only now — after the redirect_uri was proven to be one this client registered, and after
  // a real human proved they hold the key and the PIN — do we redirect. `state` is echoed
  // back verbatim; it is the client's CSRF token and its contents are none of our business.
  const target = new URL(p.redirect_uri);
  target.searchParams.set('code', code);
  if (p.state) target.searchParams.set('state', p.state);

  return NextResponse.redirect(target.toString(), { status: 302, headers: { 'Cache-Control': 'no-store' } });
}

// pinSecurity.ts's messages are written for chat channels and carry WhatsApp-style markdown.
// This is an HTML page, so the markers are stripped rather than rendered as literal asterisks
// — same intent as /api/mcp's stripMd, and the same careful handling of snake_case field
// names, which must survive untouched (see the note in src/app/api/mcp/route.ts).
function stripMd(s: string): string {
  return String(s || '')
    .replace(/(?<=^|\s)_([^_\n]+)_(?=$|[\s.,!?])/g, '$1')
    .replace(/[*`]/g, '');
}
