import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // sdk/, python-sdk/, and mcp-server/ are each their own standalone package (own
    // package.json, none of them part of this Next.js app) — none should be linted with
    // this app's Next-specific config.
    "sdk/**",
    "python-sdk/**",
    "mcp-server/**",
  ]),
]);

export default eslintConfig;