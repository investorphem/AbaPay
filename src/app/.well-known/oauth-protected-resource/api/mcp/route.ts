// RFC 9728 §3.1 — when the protected resource has a path (`/api/mcp`), a client looks for
// its metadata at /.well-known/oauth-protected-resource/api/mcp FIRST, and only falls back
// to the root document. Claude's connector does exactly this when a user adds the server by
// URL, before it has ever seen a 401 to read `resource_metadata` from. Same document, both
// places — a 404 here would mean the connect flow is never offered at all.
export { GET, OPTIONS } from '../../route';

// Route segment config must be declared literally in each route file — Next.js parses it
// statically at compile time and cannot follow a re-export.
export const dynamic = 'force-dynamic';
