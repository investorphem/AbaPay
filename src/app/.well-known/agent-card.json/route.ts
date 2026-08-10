import 'server-only';
import { NextResponse } from 'next/server';
import { TOOLS } from '@/lib/deai/mcpTools';

// ⚡ A2A AGENT CARD — the discovery document for the Agent2Agent protocol (a2a-protocol.org).
// A peer agent fetches this first to learn what AbaPay can do and where to call it.
//
// 🔴 NOT TO BE CONFUSED WITH /.well-known/agent.json. That file is AbaPay's ERC-8004
// registration card (`type: …eip-8004#registration-v1`) — the on-chain identity 8004scan and
// Aigora read. The two specs collided on the `agent.json` filename historically, which is
// exactly why A2A moved its card to `agent-card.json`. They are different documents for
// different consumers and MUST stay separate; overwriting one with the other would silently
// break the agent's on-chain listing.
//
// Served as a route rather than a static file so `url` always matches the deployment it is
// served from (preview deploys included) instead of hardcoding production.

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://abapays.com';

// A2A skills are the peer-facing view of the same tools MCP exposes — one implementation
// (src/lib/deai/mcpTools.ts), described twice for two protocols. Descriptions are pulled from
// TOOLS so a tool's docs can never drift between the MCP tool list and the A2A card.
const toolDescription = (name: string): string => {
  const t = (TOOLS as any[]).find((x) => x.name === name);
  return t?.description ? String(t.description).split('\n')[0].slice(0, 400) : name;
};

const SKILLS = [
  {
    id: 'describe_capabilities',
    name: 'Describe capabilities',
    description: toolDescription('describe_capabilities'),
    tags: ['discovery', 'capabilities'],
    examples: ['What can AbaPay pay for?'],
  },
  {
    id: 'check_balance',
    name: 'Check wallet balance',
    description: toolDescription('check_balance'),
    tags: ['balance', 'wallet', 'stablecoin', 'celo', 'base'],
    examples: ["What is the linked wallet's USDC balance and approved limit?"],
  },
  {
    id: 'list_plans',
    name: 'List purchasable plans',
    description: toolDescription('list_plans'),
    tags: ['catalogue', 'data', 'cable', 'education'],
    examples: ['List MTN data plans'],
  },
  {
    id: 'list_international_options',
    name: 'Browse international options',
    description: toolDescription('list_international_options'),
    tags: ['international', 'airtime', 'data', 'catalogue'],
    examples: ['What airtime operators are available in Ghana?'],
  },
  {
    id: 'transaction_history',
    name: 'Recent transaction history',
    description: toolDescription('transaction_history'),
    tags: ['history', 'receipts'],
    examples: ['What bills were paid recently?'],
  },
  {
    id: 'pay_bill',
    name: 'Pay a bill',
    description: toolDescription('pay_bill'),
    tags: ['payment', 'airtime', 'data', 'electricity', 'cable', 'education', 'international'],
    examples: ['Pay 1000 NGN MTN airtime for 08012345678'],
  },
];

export async function GET() {
  return NextResponse.json(
    {
      protocolVersion: '0.3.0',
      name: 'AbaPay',
      description:
        'Non-custodial bill-payment agent. Pays airtime, mobile data, electricity, cable TV, education fees and international top-ups across 170+ countries, settled in stablecoins on Celo and Base from a wallet that has granted a bounded, revocable on-chain allowance.',
      url: `${APP_URL}/api/a2a`,
      preferredTransport: 'JSONRPC',
      version: '1.0.0',
      documentationUrl: 'https://github.com/investorphem/AbaPay#a2a',
      iconUrl: `${APP_URL}/logo.png`,
      provider: {
        organization: 'AbaPay',
        url: APP_URL,
      },
      // Streaming and push both declared false — every skill here resolves synchronously
      // within the request, so `message/send` returns a completed Message rather than a
      // long-lived Task. Declaring capabilities we do not implement would strand a peer
      // waiting on updates that never arrive.
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'application/json', 'image/png'],
      // 🔴 Payments are never anonymous here. The same credential MCP uses — an OAuth 2.1
      // bearer token, or the `aba_mcp_` API key minted in Agent Hub — identifies the wallet
      // being spent from. A card that advertised no security scheme would imply otherwise.
      securitySchemes: {
        bearer: {
          type: 'http',
          scheme: 'bearer',
          description:
            'OAuth 2.1 access token (see /.well-known/oauth-authorization-server) or an AbaPay Agent Hub API key. A token authenticates the connection only — pay_bill additionally requires the wallet PIN on every single call.',
        },
      },
      security: [{ bearer: [] }],
      skills: SKILLS,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      },
    }
  );
}
