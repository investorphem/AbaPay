import { defineConfig } from "tsup";

export default defineConfig({
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
});
