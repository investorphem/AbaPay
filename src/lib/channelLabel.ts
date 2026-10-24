// Where a payment came from, in words — one list for the Telegram sale/refund alerts
// (src/lib/vend.ts, src/lib/refunds.ts) and the admin Ops panel, so they can't drift.
//
// 🔴 THE GAP THIS CLOSES: the alert's own switch knew only Telegram/WhatsApp/X/Schedule, so
// every other source fell through to "🌐 Web App" — an outside agent paying over x402, an
// MCP/A2A agent, and Nimiq Pay orders all read as web payments (2026-10-24).
//
// Values are transactions.source_channel: 'WEB' is only ever sent by our own web app (which also
// covers MiniPay/Farcaster/Base App, the same page); 'AGENT' is an outside agent on x402
// (src/app/api/pay/x402/route.ts sourceChannelFor); 'MCP' is MCP and A2A tool calls.

export function channelLabel(src: string | null | undefined): string {
  switch (String(src || 'WEB').toUpperCase()) {
    case 'WEB': return '🌐 Web App';
    case 'AGENT': return '🤖 x402 Agent';
    case 'MCP': return '🤖 MCP/A2A Agent';
    case 'A2A': return '🤖 A2A Agent';
    case 'NIMIQ': return '🟡 Nimiq Pay Mini App';
    case 'TELEGRAM': return '💬 Telegram Agent';
    case 'WHATSAPP': return '💬 WhatsApp Agent';
    case 'X': return '💬 X Agent';
    case 'SCHEDULE': return '🤖 Autonomous Schedule';
    default: return `🤖 ${String(src).toUpperCase()}`;
  }
}
