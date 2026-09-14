// ⚡ EMPTY, ON PURPOSE — this package has no CSS. postcss-load-config (used internally by
// Vite/Vitest, which this package's test runner is built on) searches UPWARD through parent
// directories for a postcss config with no package-boundary awareness — the exact same failure
// mode tsconfig.json's "DOM" lib fix addressed for TypeScript's @types resolution. Without
// this file, that search walks past sdk/ and finds the PARENT repo's real postcss.config.mjs
// (Tailwind, for the Next.js app), which then fails to load because sdk/node_modules has no
// reason to carry @tailwindcss/postcss. This file stops the search at the correct boundary by
// being the nearest match — same fix, different tool.
export default {};
