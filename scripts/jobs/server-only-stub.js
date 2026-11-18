// `server-only` marks modules that must never reach a browser bundle; Next.js provides it. The job
// runner (scripts/jobs/run.ts) is a Node process, which is exactly where these modules belong, so
// the guard is replaced by this empty module when the runner is bundled (scripts/jobs/build.mjs).
export {};
