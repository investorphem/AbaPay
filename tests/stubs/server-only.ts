// Next.js special-cases the bare `server-only` import at build time (via webpack/turbopack)
// without it needing to be an installed package — importing it is a no-op there. Vitest has
// no such special-casing and fails to resolve it at all, which silently blocked every test
// from importing anything under src/lib/** that imports 'server-only' (most of it), despite
// vitest.config.ts's own coverage.include listing src/lib/** as covered. Aliased in
// vitest.config.ts. Safe: the package's real purpose is a browser-bundle guard, irrelevant to
// a Node-only test run.
export {};
