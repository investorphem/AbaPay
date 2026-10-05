#!/usr/bin/env node
// 🪜 LINT RATCHET (M7). The codebase carries a lint backlog that can't be cleared in one PR,
// so "lint must pass" isn't a gate anyone can turn on. This is: every (file, rule) pair may
// have at most as many problems as `eslint-baseline.json` records, so new code can't add any
// and the count only ever goes down.
//
//   node scripts/lint-ratchet.mjs           check (CI). Fails on any (file, rule) above baseline.
//   node scripts/lint-ratchet.mjs --update  rewrite the baseline to today's counts, after you
//                                           fixed some. Refuses to raise any count.
import { ESLint } from 'eslint';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASELINE = path.resolve('eslint-baseline.json');
const update = process.argv.includes('--update');

// Only files git tracks, so a local checkout and CI lint exactly the same set (and nothing
// untracked or local-only ever lands in the committed baseline).
const tracked = execFileSync('git', ['ls-files', '-z', '--', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.ts', '*.tsx', '*.mts', '*.cts'], { encoding: 'utf8' })
  .split(String.fromCharCode(0))
  .filter(Boolean);
const eslint = new ESLint();
const files = [];
for (const f of tracked) if (!(await eslint.isPathIgnored(f))) files.push(f);
const results = await eslint.lintFiles(files);

const current = {};
for (const r of results) {
  const file = path.relative(process.cwd(), r.filePath).split(path.sep).join('/');
  for (const m of r.messages) {
    if (m.fatal) {
      console.error(`::error file=${file},line=${m.line}::${m.message}`);
      process.exitCode = 1;
      continue;
    }
    const rule = m.ruleId || 'eslint';
    current[file] ??= {};
    current[file][rule] = (current[file][rule] || 0) + 1;
  }
}
if (process.exitCode) process.exit(1); // a parse error is never baselined

const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {};
const total = (o) => Object.values(o).reduce((n, rules) => n + Object.values(rules).reduce((a, b) => a + b, 0), 0);

const over = [];
let improved = 0;
for (const [file, rules] of Object.entries(current)) {
  for (const [rule, n] of Object.entries(rules)) {
    const allowed = baseline[file]?.[rule] || 0;
    if (n > allowed) over.push({ file, rule, n, allowed });
  }
}
for (const [file, rules] of Object.entries(baseline)) {
  for (const [rule, allowed] of Object.entries(rules)) {
    if ((current[file]?.[rule] || 0) < allowed) improved++;
  }
}

const first = update && !fs.existsSync(BASELINE);
if (over.length && !first) {
  for (const o of over) {
    console.error(`::error file=${o.file}::${o.rule}: ${o.n} problem(s), baseline allows ${o.allowed}`);
  }
  console.error(`\n${over.length} (file, rule) pair(s) got worse. Fix the new problems (run \`npx eslint <file>\` to see them); the baseline only goes down.`);
  process.exit(1);
}

if (update) {
  const sorted = Object.fromEntries(Object.keys(current).sort().map((f) => [f, Object.fromEntries(Object.entries(current[f]).sort())]));
  fs.writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`Baseline updated: ${total(baseline)} → ${total(current)} problems.`);
} else {
  console.log(`Lint ratchet OK: ${total(current)} problems (baseline ${total(baseline)}).`);
  if (improved) console.log(`${improved} (file, rule) pair(s) improved. Run \`npm run lint:ratchet -- --update\` and commit eslint-baseline.json to lock it in.`);
}
