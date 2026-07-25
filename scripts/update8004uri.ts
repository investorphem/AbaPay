import hre from "hardhat";

/**
 * Re-pushes AbaPay's ERC-8004 agent URI on-chain WITHOUT changing it, purely to emit a fresh
 * `URIUpdated` event.
 *
 * WHY THIS SCRIPT EXISTS: `register8004.ts` only ever registers a NEW identity. It has no
 * "tell the indexer something changed" story for after the fact — and 8004scan (and any other
 * ERC-8004 indexer) appears to snapshot the agent card at registration time rather than
 * polling the URL on a schedule. Editing `public/.well-known/agent.json` (e.g. to add the new
 * `mcp` service type) updates what the URL RETURNS immediately, but does nothing to tell an
 * indexer that already has a stale copy to go fetch it again — there's no on-chain signal to
 * react to. `setAgentURI(agentId, sameURI)` on the registry re-emits `URIUpdated`, which is a
 * genuine on-chain event an indexer can pick up to trigger a re-fetch, even though the URI
 * string itself is unchanged.
 *
 * This is identity-only — it does NOT touch payments, and does not change the URI itself
 * (still `https://abapays.com/.well-known/agent.json` for both chains).
 *
 * Only the WALLET THAT ORIGINALLY REGISTERED THE AGENT (the owner of the ERC-721 with this
 * tokenId — the same CELO_PRIVATE_KEY hardhat.config.ts already uses for every network here)
 * can call this; the registry's `setAgentURI` reverts with "Not authorized" for anyone else.
 *
 * Usage — run once per chain, with that chain's live agent ID:
 *   ERC8004_AGENT_ID=9687  ERC8004_AGENT_URI=https://abapays.com/.well-known/agent.json \
 *     npx hardhat run scripts/update8004uri.ts --network celo
 *   ERC8004_AGENT_ID=59561 ERC8004_AGENT_URI=https://abapays.com/.well-known/agent.json \
 *     npx hardhat run scripts/update8004uri.ts --network base
 */

const REGISTRY_ABI = [
  {
    inputs: [
      { internalType: "uint256", name: "agentId", type: "uint256" },
      { internalType: "string", name: "newURI", type: "string" },
    ],
    name: "setAgentURI",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "agentId", type: "uint256" },
      { indexed: false, internalType: "string", name: "newURI", type: "string" },
      { indexed: true, internalType: "address", name: "updatedBy", type: "address" },
    ],
    name: "URIUpdated",
    type: "event",
  },
];

// Same registry addresses register8004.ts uses — see that script's header for how the Base
// address was confirmed (byte-identical bytecode to Celo mainnet, verified via eth_getCode).
const DEFAULT_REGISTRY: Record<string, string> = {
  celo: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  sepolia: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  base: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
};

async function main() {
  const networkName = hre.network.name;
  console.log(`🔄 Re-pushing AbaPay's ERC-8004 agent URI (${networkName})...`);

  const agentId = process.env.ERC8004_AGENT_ID;
  if (!agentId || !/^\d+$/.test(agentId)) {
    throw new Error(
      "Set ERC8004_AGENT_ID to this chain's live agent ID (Celo: 9687, Base: 59561) before running this script."
    );
  }

  const agentURI = process.env.ERC8004_AGENT_URI || "https://abapays.com/.well-known/agent.json";

  const registryAddress =
    networkName === "celo" ? (process.env.ERC8004_REGISTRY_CELO_MAINNET || DEFAULT_REGISTRY.celo)
    : networkName === "base" ? (process.env.ERC8004_REGISTRY_BASE_MAINNET || DEFAULT_REGISTRY.base)
    : (process.env.ERC8004_REGISTRY_CELO_SEPOLIA || DEFAULT_REGISTRY.sepolia);

  console.log(`📇 Registry: ${registryAddress}`);
  console.log(`🪪 Agent ID: ${agentId}`);
  console.log(`🔗 Agent card (unchanged): ${agentURI}`);

  const signer = (await hre.ethers.getSigners())[0];
  console.log(`👤 Sending from: ${signer.address}`);

  const registry = new hre.ethers.Contract(registryAddress, REGISTRY_ABI, signer);

  const tx = await registry.setAgentURI(agentId, agentURI);
  console.log(`⏳ Tx sent: ${tx.hash} — waiting for confirmation...`);
  const receipt = await tx.wait();

  const emitted = (receipt?.logs ?? []).some((log: any) => {
    try {
      return registry.interface.parseLog(log)?.name === "URIUpdated";
    } catch {
      return false;
    }
  });

  console.log(`\n${emitted ? "🎉" : "⚠️"} --- ${emitted ? "URI RE-PUSHED" : "TX CONFIRMED (URIUpdated not found in logs — check manually)"} --- `);
  console.log(`Tx: ${tx.hash}`);
  console.log(
    `\nGive the indexer a few minutes, then check https://8004scan.io/agents/${networkName === "base" ? "base" : "celo"}/${agentId} ` +
    `and re-run "Check Health" there — that click is owner-gated on their site and can't be automated from here.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
