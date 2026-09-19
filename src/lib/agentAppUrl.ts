// Canonicalizes NEXT_PUBLIC_APP_URL for agent-facing protocol metadata (the A2A agent card,
// the OAuth 2.1 discovery documents) to agents.abapays.com on any real abapays.com deployment,
// while still letting preview deployments and localhost echo their own URL for testing — the
// same rule already applied client-side in AgentHub.tsx's copyable MCP server URL.
export function getAgentAppUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL || 'https://abapays.com';
  try {
    const { hostname } = new URL(raw);
    if (/(^|\.)abapays\.com$/i.test(hostname)) {
      return 'https://agents.abapays.com';
    }
  } catch {
    // raw wasn't a valid absolute URL — use it as-is rather than crash.
  }
  return raw;
}
