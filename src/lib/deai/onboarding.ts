// src/lib/deai/onboarding.ts
//
// The first-contact feature tour — a numbered walkthrough of what AbaPay can do, shown
// automatically the very first time a chat ever messages the bot (see core/route.ts, search
// "ONBOARDING"). There is no button/quick-reply primitive on WhatsApp, Telegram, or X in this
// codebase (see src/lib/deai/selection.ts's renderOptions), so — like every other menu in this
// bot — navigation is plain numbered text: reply NEXT/CANCEL, exactly like everywhere else.

// Each entry is one step's body. Keep them short — this is a chat window, not a brochure.
export const ONBOARDING_STEPS: string[] = [
  `👋 *Welcome to AbaPay!*\n\nI'm your money assistant, right here in chat — no separate app needed for most things. Let me show you around in a few short messages.\n\n_Reply *NEXT* to continue, or *CANCEL* anytime to skip straight to your own request._`,

  `📱 *Airtime & Data*\n\nTop up any Nigerian network — MTN, Airtel, Glo, 9mobile — instantly.\n\n_Try: "buy 500 MTN airtime for 08012345678"_`,

  `⚡ *Electricity, Cable TV & Education*\n\n• Pay prepaid or postpaid electricity meters\n• Subscribe or renew DStv, GOtv, Startimes\n• Buy WAEC/JAMB result-checker PINs\n\n_Just tell me what you need — I'll ask for anything missing._`,

  `👥 *Pay several people in one go*\n\nSend to multiple recipients in a single message instead of repeating yourself.\n\n_Try: "send 1000 airtime to 08011112222 and 08033334444"_`,

  `⏰ *Set it and forget it*\n\nSchedule a bill to repeat automatically — weekly data, monthly electricity — and I'll pay it and notify you here when it runs.\n\n_Try: "schedule 1GB MTN data every Monday"_`,

  `🪙 *Your crypto wallet*\n\nLink your wallet once in the AbaPay app, then pay straight from your balance — cUSD, USDC or USDT on Celo or Base — confirming with just your PIN after that.\n\n_Ask me "what's my balance?" anytime._`,

  `🌍 *Works across borders*\n\nI can also top up airtime and data for numbers outside Nigeria — just tell me the country and number.`,

  `🔒 *Your money stays safe*\n\nEvery payment needs your PIN to confirm. If anything ever feels off, message *"revoke"* from any linked chat and I'll cut off agent access instantly.`,

  `✅ *That's the tour!*\n\nType *GUIDE* anytime to see this again. Otherwise, just tell me what you'd like to do — e.g. _"buy 500 MTN airtime for 08012345678"_.`,
];

// Explicit on-demand replay — works from any state, for any user, new or returning.
export const ONBOARDING_TRIGGER_RE = /^(guide|tour|tutorial|walkthrough|show me around|onboarding)$/i;
export const ONBOARDING_NEXT_RE = /^(next|continue|n|go on)$/i;
export const ONBOARDING_CANCEL_RE = /^(cancel|skip|stop|no thanks|no|exit)$/i;

export function renderOnboardingStep(step: number): string {
  const total = ONBOARDING_STEPS.length;
  const clamped = Math.max(0, Math.min(step, total - 1));
  const body = ONBOARDING_STEPS[clamped];
  const isLast = clamped === total - 1;
  const header = isLast ? '' : `*(Step ${clamped + 1}/${total})*\n\n`;
  return `${header}${body}`;
}

export function isLastOnboardingStep(step: number): boolean {
  return step >= ONBOARDING_STEPS.length - 1;
}
