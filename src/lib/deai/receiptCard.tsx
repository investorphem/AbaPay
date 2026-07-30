import 'server-only';
import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ⚡ PREMIUM MCP RECEIPTS — rendered server-side with next/og's ImageResponse (Satori +
// Resvg, bundled with Next.js — no extra dependency) and returned as an `image` content
// block alongside the plain-text result, so a pay_bill/list_transactions call in Claude (or
// any MCP client that renders inline images) shows a branded card, not just a wall of text.
//
// 🔴 NO NAIRA GLYPH INSIDE THE IMAGE: Satori's bundled default font is a subset that does not
// reliably include "₦" — an unsupported glyph renders as a blank/tofu box, which would make
// the "premium" card look broken rather than premium. The plain-text MCP responses keep using
// ₦ freely (that's just UTF-8 text in a chat message, no font subsetting involved); anything
// baked into a PNG here spells it out as "NGN" instead.

let logoDataUrlPromise: Promise<string> | null = null;
function getLogoDataUrl(): Promise<string> {
  if (!logoDataUrlPromise) {
    logoDataUrlPromise = readFile(join(process.cwd(), 'public/logo.png')).then(
      (buf) => `data:image/png;base64,${buf.toString('base64')}`
    );
  }
  return logoDataUrlPromise;
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
        {value}
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
  const logo = await getLogoDataUrl();
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <img src={logo} width={40} height={28} style={{ objectFit: 'contain' as any }} />
              <span style={{ display: 'flex', fontSize: 26, fontWeight: 800, color: WHITE, letterSpacing: -0.5 }}>AbaPay</span>
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
                fontSize: 20,
                fontWeight: 800,
                color: '#0b0b0e',
              }}
            >
              {ok ? '✓' : '!'}
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
            <span style={{ display: 'flex', fontSize: 50, color: WHITE, fontWeight: 800, marginTop: 4 }}>{data.displayAmountNgn}</span>
            <span style={{ display: 'flex', fontSize: 16, color: MUTED, marginTop: 2 }}>{data.cryptoCharged}</span>
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
  const logo = await getLogoDataUrl();
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <img src={logo} width={40} height={28} style={{ objectFit: 'contain' as any }} />
              <span style={{ display: 'flex', fontSize: 26, fontWeight: 800, color: WHITE, letterSpacing: -0.5 }}>AbaPay</span>
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
                    <span style={{ display: 'flex', fontSize: 16, fontWeight: 700, color: WHITE }}>{row.serviceLabel}</span>
                    <span style={{ display: 'flex', fontSize: 13, color: MUTED, marginTop: 2 }}>
                      {row.date} • {row.accountNumber}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                    <span style={{ display: 'flex', fontSize: 16, fontWeight: 800, color: WHITE }}>{row.displayAmountNgn}</span>
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
