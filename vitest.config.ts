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

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/utils/**', 'src/lib/**', 'src/constants/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
