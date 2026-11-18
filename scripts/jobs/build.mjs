#!/usr/bin/env node
// Bundles the background-job runner (scripts/jobs/run.ts) into .jobs-dist/run.cjs so GitHub Actions
// can run AbaPay's job code with plain Node: esbuild resolves the `@/…` paths from tsconfig.json and
// swaps Next.js's `server-only` guard for an empty module. npm packages stay external (node_modules).
import { build } from 'esbuild';
import path from 'node:path';

await build({
  entryPoints: ['scripts/jobs/run.ts'],
  outfile: '.jobs-dist/run.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'external',
  tsconfig: 'tsconfig.json',
  alias: { 'server-only': path.resolve('scripts/jobs/server-only-stub.js') },
  logLevel: 'warning',
});
console.log('built .jobs-dist/run.cjs');
