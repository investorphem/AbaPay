import { defineConfig } from "tsup";

// Two build targets from one `tsup` invocation (tsup accepts an array of configs as the
// default export) — the library (dual ESM/CJS, typed) and the CLI (ESM-only, shebang banner,
// no .d.ts since nothing imports it as a library). Kept as one file/one command rather than
// two separate tsup configs so `npm run build` stays a single, unchanged entry point.
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    // viem is a peer dependency, not bundled — a consumer's own viem version signs/verifies,
    // so a mismatch is visible as their own dependency tree rather than a silently duplicated
    // second copy inside this package.
    external: ["viem"],
  },
  {
    // src/cli.ts's own "#!/usr/bin/env node" first line is picked up and preserved by tsup
    // automatically — an explicit `banner` here duplicated it into two shebang lines, which
    // Node's ESM loader rejects outright ("Invalid or unexpected token"). Caught by actually
    // running the built dist/cli.js, not just typechecking the source.
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    dts: false,
    sourcemap: false,
    clean: false,
    target: "es2022",
    external: ["viem"],
  },
]);
