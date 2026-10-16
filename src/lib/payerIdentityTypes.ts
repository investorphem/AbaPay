// Shapes of migration 044's payer_identities row. Separate from src/lib/payerIdentity.ts (server
// only) so the admin dashboard's client component can use them.

export interface Erc8004Agent {
  id: string;
  /** How this wallet relates to the agent: it holds the identity NFT, or the registry names it as the agent's wallet. */
  relation: 'owner' | 'agent_wallet';
  name?: string;
  description?: string;
  web?: string;
  x402?: string;
  image?: string;
  active?: boolean;
}

export interface PayerIdentity {
  wallet: string;
  erc8004_agents: Erc8004Agent[];
  self_verified: boolean | null;
  self_agent_id: string | null;
  self_human_proof: boolean | null;
  self_proof_fresh: boolean | null;
  checked_at: string;
  lookup_error: string | null;
}
