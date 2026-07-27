// RFC 8414 §3.1 path-insertion variant, for the same reason as its oauth-protected-resource
// counterpart: some clients probe /.well-known/oauth-authorization-server/<resource-path>
// before the root document. Our issuer has no path component, so both serve the identical
// metadata.
export { GET, OPTIONS } from '../../route';

// Route segment config must be declared literally in each route file — Next.js parses it
// statically at compile time and cannot follow a re-export.
export const dynamic = 'force-dynamic';
