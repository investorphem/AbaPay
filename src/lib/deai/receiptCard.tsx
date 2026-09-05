import 'server-only';
import { ImageResponse } from 'next/og';
import { LOGO_DATA_URL } from './logoDataUrl';

// ⚡ PREMIUM MCP RECEIPTS — rendered server-side with next/og's ImageResponse (Satori +
// Resvg, bundled with Next.js — no extra dependency) and returned as an `image` content
// block alongside the plain-text result, so a pay_bill/list_transactions call in Claude (or
// any MCP client that renders inline images) shows a branded card, not just a wall of text.
//
// 🔴 NO EXOTIC GLYPHS INSIDE THE IMAGE: Satori's bundled default font is a subset that does
// not cover "₦" (confirmed by design — callers pre-format as "NGN" for image use) or "₮" (found
// live in production: "USD₮" rendered with a blank/tofu box where the Tether sign should be —
// the original comment on cryptoCharged claiming "Latin token symbols only" was simply wrong).
// An unsupported glyph renders as a blank box, which makes the "premium" card look broken
// rather than premium. The plain-text MCP responses keep using ₦/₮ freely (that's just UTF-8
// text in a chat message, no font subsetting involved) — this sanitizer only ever touches what
// gets baked into the PNG.
function imgSafe(s: string): string {
  return String(s || '').replace(/₦/g, 'NGN ').replace(/₮/g, 'T');
}

// 🔴 THE BUG THIS FIXES: this used to read public/logo.png from the filesystem at request
// time via node:fs. Next.js does NOT automatically bundle public/ assets into a serverless API
// route's own filesystem (they're served separately via the CDN, not expected to be read back
// by function code) — so this could throw ENOENT in production despite working locally. Worse,
// the failed promise was cached in a module-level variable and NEVER reset on rejection, so
// once it failed once, every subsequent receipt/history image render in that warm serverless
// instance failed identically until a cold start — silently, since both call sites wrap this
// in a try/catch that falls back to plain text. This is very likely why MCP receipts and
// transaction_history were never showing the "rich card" image, only a plain link, exactly as
// reported live. Embedding the logo as a build-time base64 constant (logoDataUrl.ts) removes
// the filesystem dependency — and therefore this whole failure class — entirely.
function getLogoDataUrl(): string {
  return LOGO_DATA_URL;
}

const BG = '#0b0b0e';
const CARD_BG = '#15151a';
const BORDER = 'rgba(148,163,184,0.16)';
const MUTED = '#94a3b8';
const EMERALD = '#10b981';
const RED = '#f87171';
const WHITE = '#f8fafc';

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 24 }}>
      <span style={{ display: 'flex', fontSize: 16, color: MUTED, fontWeight: 600 }}>{label}</span>
      <span
        style={{
          display: 'flex',
          fontSize: 16,
          color: accent ? EMERALD : WHITE,
          fontWeight: 700,
          textAlign: 'right',
        }}
      >
        {imgSafe(value)}
      </span>
    </div>
  );
}

export interface ReceiptCardData {
  status: 'SUCCESS' | 'FAILED_VENDING' | 'PENDING';
  serviceLabel: string;
  accountNumber: string;
  customerName?: string | null;
  customerAddress?: string | null;
  displayAmountNgn: string;   // pre-formatted, NO ₦ symbol — e.g. "NGN 5,000"
  cryptoCharged: string;      // e.g. "3.333333 USD₮" (Latin token symbols only — fine)
  purchasedCode?: string | null;
  units?: string | null;
  referenceId?: string | null;
  txHash: string;
  chain: string;
}

// Returns the ImageResponse itself (a Response subtype) — usable directly as the default
// export of an opengraph-image.tsx file convention, or converted to a Buffer for the MCP
// `image` content block (see renderReceiptImage below).
export async function receiptImageResponse(data: ReceiptCardData): Promise<ImageResponse> {
  const logo = getLogoDataUrl();
  const ok = data.status === 'SUCCESS';
  const accent = ok ? EMERALD : RED;
  const isElectricity = /electric/i.test(data.serviceLabel);

  const image = new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', background: BG, padding: 36 }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            background: CARD_BG,
            border: `1px solid ${BORDER}`,
            borderRadius: 32,
            padding: 44,
          }}
        >
          {/* header */}
          {/* 🔴 THE "logo barely shows" COMPLAINT: this used to be 40×28 next to 26px bold
              text — on a 960×760 card, the circular "AB" mark (arrow + swirl detail) was too
              small to read as a logo at a glance. logo.png is 512×361 (ratio ~1.42); sized up
              to 64×45 here keeps that exact ratio (no squish) while actually being legible. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <img src={logo} width={64} height={45} style={{ objectFit: 'contain' as any }} />
              <span style={{ display: 'flex', fontSize: 28, fontWeight: 800, color: WHITE, letterSpacing: -0.5 }}>AbaPay</span>
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: 13,
                fontWeight: 700,
                color: MUTED,
                letterSpacing: 2,
                textTransform: 'uppercase',
                border: `1px solid ${BORDER}`,
                borderRadius: 999,
                padding: '6px 18px',
              }}
            >
              {data.chain}
            </div>
          </div>

          {/* status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 34 }}>
            <div
              style={{
                display: 'flex',
                width: 38,
                height: 38,
                borderRadius: 999,
                background: accent,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {ok ? (
                // Drawn with borders, not a "✓" glyph — Satori's bundled font doesn't cover it
                // (confirmed live: it rendered as a blank tofu box in production).
                <div style={{ display: 'flex', width: 14, height: 8, marginTop: -2, borderLeft: '3px solid #0b0b0e', borderBottom: '3px solid #0b0b0e', transform: 'rotate(-45deg)' }} />
              ) : (
                <span style={{ display: 'flex', fontSize: 20, fontWeight: 800, color: '#0b0b0e' }}>!</span>
              )}
            </div>
            <span style={{ display: 'flex', fontSize: 22, fontWeight: 800, color: accent }}>
              {ok ? 'Payment Successful' : 'Payment Failed'}
            </span>
          </div>

          {/* amount */}
          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 28 }}>
            <span style={{ display: 'flex', fontSize: 14, color: MUTED, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5 }}>
              Amount Paid
            </span>
            <span style={{ display: 'flex', fontSize: 50, color: WHITE, fontWeight: 800, marginTop: 4 }}>{imgSafe(data.displayAmountNgn)}</span>
            <span style={{ display: 'flex', fontSize: 16, color: MUTED, marginTop: 2 }}>{imgSafe(data.cryptoCharged)}</span>
          </div>

          {/* details */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              marginTop: 30,
              gap: 15,
              borderTop: `1px solid ${BORDER}`,
              paddingTop: 26,
            }}
          >
            <Row label="Service" value={data.serviceLabel} />
            <Row label={isElectricity ? 'Meter Number' : 'Account'} value={data.accountNumber} />
            {data.customerName ? <Row label="Name" value={data.customerName} /> : null}
            {data.customerAddress ? <Row label="Address" value={data.customerAddress} /> : null}
            {data.purchasedCode ? <Row label={isElectricity ? 'Token' : 'PIN'} value={data.purchasedCode} accent /> : null}
            {data.units ? <Row label="Units" value={data.units} /> : null}
            {data.referenceId ? <Row label="Reference" value={data.referenceId} /> : null}
          </div>

          {/* footer */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginTop: 'auto',
              paddingTop: 26,
              borderTop: `1px solid ${BORDER}`,
            }}
          >
            <span style={{ display: 'flex', fontSize: 14, color: MUTED }}>
              {data.txHash.slice(0, 10)}...{data.txHash.slice(-8)}
            </span>
            <span style={{ display: 'flex', fontSize: 14, color: MUTED }}>Secured on {data.chain}</span>
          </div>
        </div>
      </div>
    ),
    { width: 960, height: 760 }
  );

  return image;
}

export async function renderReceiptImage(data: ReceiptCardData): Promise<Buffer> {
  const image = await receiptImageResponse(data);
  return Buffer.from(await image.arrayBuffer());
}

export interface HistoryRow {
  date: string;
  serviceLabel: string;
  accountNumber: string;
  displayAmountNgn: string; // NO ₦ symbol — see note above
  status: string;
}

export async function renderHistoryStatementImage(rows: HistoryRow[], wallet: string): Promise<Buffer> {
  const logo = getLogoDataUrl();
  const shown = rows.slice(0, 8);

  const image = new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', background: BG, padding: 36 }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            background: CARD_BG,
            border: `1px solid ${BORDER}`,
            borderRadius: 32,
            padding: 44,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <img src={logo} width={64} height={45} style={{ objectFit: 'contain' as any }} />
              <span style={{ display: 'flex', fontSize: 28, fontWeight: 800, color: WHITE, letterSpacing: -0.5 }}>AbaPay</span>
            </div>
            <span style={{ display: 'flex', fontSize: 14, color: MUTED, fontWeight: 600 }}>
              {wallet.slice(0, 6)}...{wallet.slice(-4)}
            </span>
          </div>

          <span style={{ display: 'flex', fontSize: 22, fontWeight: 800, color: WHITE, marginTop: 30 }}>Recent Activity</span>

          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 20, gap: 0 }}>
            {shown.map((row, i) => {
              const ok = row.status === 'SUCCESS';
              const color = ok ? EMERALD : row.status === 'REFUNDED' ? '#60a5fa' : RED;
              return (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '16px 0',
                    borderTop: i === 0 ? 'none' : `1px solid ${BORDER}`,
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ display: 'flex', fontSize: 16, fontWeight: 700, color: WHITE }}>{imgSafe(row.serviceLabel)}</span>
                    <span style={{ display: 'flex', fontSize: 13, color: MUTED, marginTop: 2 }}>
                      {row.date} - {imgSafe(row.accountNumber)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                    <span style={{ display: 'flex', fontSize: 16, fontWeight: 800, color: WHITE }}>{imgSafe(row.displayAmountNgn)}</span>
                    <span style={{ display: 'flex', fontSize: 12, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }}>
                      {row.status}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    ),
    { width: 960, height: 200 + shown.length * 64 + 300 }
  );

  return Buffer.from(await image.arrayBuffer());
}
