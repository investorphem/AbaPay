import 'server-only';

// ⚡ SHARED RECEIPT EMAIL TEMPLATE
//
// WHY THIS EXISTS:
// Receipt emails were being sent from FOUR different places — /api/pay, /api/webhook,
// /api/webhook/vtpass and /api/requery — each with its own hand-rolled HTML. They drifted:
// /api/pay had the full premium design (logo, itemised rows, community footer), while the
// webhook path sent a stripped-down "AbaPay / Account: / Tx Hash:" email.
//
// Because the webhook completes the vend whenever the frontend doesn't confirm in time
// (delayed confirmations, sponsored Base transactions, dropped connections), users were
// randomly receiving the plain email instead of the premium one — which looked like a
// regression but was really "a different code path won the race".
//
// One template. One place to change it. All paths call this.

export interface ReceiptEmailData {
  displayAmount: string;        // e.g. "₦2,000" or "GHS 2.50" — already formatted
  serviceLabel: string;         // e.g. "IBADAN-ELECTRIC ELECTRICITY"
  accountNumber: string;        // meter / phone / account
  cryptoCharged?: string;       // e.g. "1.5672 cUSD"
  txHash?: string;
  purchasedCode?: string | null;  // electricity token / exam PIN
  units?: string | null;          // electricity units (kWh)
  referenceId?: string | null;    // shown when there's no token/PIN
  customerName?: string | null;   // ⚡ from VTpass merchant-verify (electricity/bank)
  customerAddress?: string | null;// ⚡ from VTpass merchant-verify (electricity)
  isDelayed?: boolean;            // vended late via webhook/requery
}

function row(label: string, value: string, opts: { mono?: boolean; highlight?: boolean; labelWidth?: number } = {}) {
  const labelWidth = opts.labelWidth ?? 40;
  const valueStyle = opts.highlight
    ? 'font-size: 14px; font-weight: 800; color: #10b981; letter-spacing: 1px;'
    : opts.mono
      ? 'font-size: 12px; font-weight: 500; color: #334155; word-break: break-all; font-family: monospace;'
      : 'font-size: 13px; font-weight: 600; color: #334155;';

  return `
    <div style="border-top: 1px solid #e2e8f0; padding: 16px 0; display: table; width: 100%;">
      <div style="display: table-cell; width: ${labelWidth}%; font-size: 13px; color: #64748b;">${label}</div>
      <div style="display: table-cell; width: ${100 - labelWidth}%; ${valueStyle} text-align: right;">${value}</div>
    </div>`;
}

export function buildReceiptEmail(d: ReceiptEmailData): string {
  const rows: string[] = [];

  rows.push(row('Service', d.serviceLabel.toUpperCase()));

  // ⚡ Customer details from VTpass merchant-verify. Only shown when present, so this is
  // safe for airtime/data (which have no registered customer name).
  if (d.customerName) rows.push(row('Customer Name', d.customerName));
  if (d.customerAddress) rows.push(row('Address', d.customerAddress, { labelWidth: 30 }));

  rows.push(row('Account / Phone', d.accountNumber));
  if (d.cryptoCharged) rows.push(row('Crypto Charged', d.cryptoCharged));
  if (d.units) rows.push(row('Units', d.units));
  if (d.txHash) rows.push(row('Transaction Hash', d.txHash, { mono: true, labelWidth: 30 }));

  if (d.purchasedCode) {
    rows.push(row('Token / PIN', `Token : ${d.purchasedCode}`, { highlight: true }));
  } else if (d.referenceId) {
    rows.push(row('Reference ID', d.referenceId));
  }

  const heading = d.isDelayed ? 'Transaction Successful (Delayed)' : 'Transaction Successful';

  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #fdfbf7; padding: 40px 20px;">
    <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
      <div style="background-color: #111114; padding: 40px 20px; text-align: center; border-bottom: 4px solid #10b981;">
        <img src="https://abapays.com/logo.png" alt="AbaPay" style="height: 48px; width: auto;" />
      </div>
      <div style="padding: 40px 30px;">
        <p style="font-size: 11px; font-weight: 700; color: #64748b; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 8px 0;">${heading}</p>
        <h2 style="font-size: 36px; font-weight: 900; color: #0f172a; margin: 0 0 32px 0; letter-spacing: -1px;">${d.displayAmount}</h2>
        ${rows.join('')}
        <div style="border-top: 1px solid #e2e8f0; padding-top: 32px; margin-top: 16px;">
          <p style="font-size: 12px; color: #64748b; line-height: 1.5; margin: 0;">If you have any issues with this transaction, please reply directly to this email to reach our support desk.</p>
        </div>
      </div>
      <div style="background-color: #f8fafc; padding: 30px; text-align: center; border-top: 1px solid #e2e8f0;">
        <p style="font-size: 11px; color: #64748b; margin: 0 0 8px 0;">Join the AbaPay Community</p>
        <p style="font-size: 12px; font-weight: 700; margin: 0 0 16px 0;">
          <a href="https://x.com/abapays" style="color: #334155; text-decoration: none;">X (Twitter)</a> &nbsp;&nbsp;
          <a href="https://t.me/abapays" style="color: #334155; text-decoration: none;">Telegram</a> &nbsp;&nbsp;
          <a href="https://wa.me/2347075418792" style="color: #334155; text-decoration: none;">WhatsApp</a>
        </p>
        <p style="font-size: 10px; color: #94a3b8; margin: 0;">&copy; 2026 Masonode Technologies Limited (RC 9524980). All rights reserved.</p>
      </div>
    </div>
  </div>`;
}
