import { defineConfig } from 'vitest/config';
import path from 'path';
import dotenv from 'dotenv';

// Same file Next.js itself reads (`next dev`/`next build` load .env.local automatically) —
// vitest doesn't, so without this every test silently ran with an empty process.env.*, and
// anything gated on a real secret (e.g. tests/intentEngine.simulated.test.ts's live
// ANTHROPIC_API_KEY calls) skipped itself even on a machine that has one configured.
// quiet: true suppresses dotenv's own stdout banner (a promotional "tip" line unrelated to
// this project) — this call still loads every var exactly the same.
dotenv.config({ path: path.resolve(__dirname, '.env.local'), quiet: true });

// The four routes that take or settle a payment.
const MONEY_ROUTES = [
  'src/app/api/pay/route.ts',
  'src/app/api/pay/x402/route.ts',
  'src/app/api/webhook/route.ts',
  'src/app/api/webhook/vtpass/route.ts',
];

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/utils/**', 'src/lib/**', 'src/constants/**', ...MONEY_ROUTES],
      // M7: the code that moves or owes money can't lose test coverage. Each file has its own
      // line floor (CI runs `npm run test:coverage`). The target is 80%; files still below it
      // are pinned at today's level so they can only go up. Raise a floor when you add tests.
      thresholds: {
        'src/lib/paymentProof.ts': { lines: 80 },
        'src/lib/vend.ts': { lines: 80 },
        'src/lib/refunds.ts': { lines: 80 },
        'src/lib/refundVerify.ts': { lines: 80 },
        'src/lib/reconcileStuck.ts': { lines: 80 },
        'src/lib/reconcileX402.ts': { lines: 77 }, // below target
        'src/lib/x402Settle.ts': { lines: 80 },
        'src/lib/jobs.ts': { lines: 80 },
        'src/app/api/pay/route.ts': { lines: 80 },
        'src/app/api/pay/x402/route.ts': { lines: 77 }, // below target
        'src/app/api/webhook/route.ts': { lines: 80 },
        'src/app/api/webhook/vtpass/route.ts': { lines: 80 },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
