import { describe, it, expect } from 'vitest';

// vitest.config.ts loads only ANTHROPIC_API_KEY from .env.local. Before 2026-11-15 it loaded the
// whole file, and tests that didn't mock src/lib/telegram (tests/x402Settle.test.ts) posted their
// fixtures to the real ops channel from developers' machines. This keeps it that way.
describe('test environment', () => {
  it.each(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ADMIN_CHAT_ID', 'VTPASS_API_KEY', 'VTPASS_SECRET_KEY', 'RESEND_API_KEY'])(
    'has no live %s', (key) => expect(process.env[key]).toBeUndefined(),
  );
});
