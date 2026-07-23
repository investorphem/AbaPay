import hre from "hardhat";

/**
 * Re-submits an already-registered agent's URI on-chain via `setAgentURI(agentId, newURI)`.
 * This does NOT change identity — it's a no-op content-wise if newURI is unchanged from what's
 * already set. Its only purpose is to emit the on-chain update event that 8004scan.io's indexer
 * listens for, so it re-crawls the (already-correct) off-chain agent.json instead of serving a
 * stale cached copy. See scripts/register8004.ts for the original mint-time registration.
 *
 * Usage:
 *   ERC8004_AGENT_ID=9687 ERC8004_AGENT_URI=https://abapays.com/.well-known/agent.json \
 *     npx hardhat run scripts/setAgentURI.ts --network celo
 *   ERC8004_AGENT_ID=59561 ERC8004_AGENT_URI=https://abapays.com/.well-known/agent.json \
 *     npx hardhat run scripts/setAgentURI.ts --network base
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
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "tokenURI",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
];

const DEFAULT_REGISTRY: Record<string, string> = {
  celo: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  sepolia: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  base: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
};

async function main() {
  const networkName = hre.network.name;

  const agentIdRaw = process.env.ERC8004_AGENT_ID;
  const newURI = process.env.ERC8004_AGENT_URI;
  if (!agentIdRaw || !newURI) {
    throw new Error("Set both ERC8004_AGENT_ID and ERC8004_AGENT_URI before running this script.");
  }
  const agentId = BigInt(agentIdRaw);

  const registryAddress =
    networkName === "celo" ? (process.env.ERC8004_REGISTRY_CELO_MAINNET || DEFAULT_REGISTRY.celo)
    : networkName === "base" ? (process.env.ERC8004_REGISTRY_BASE_MAINNET || DEFAULT_REGISTRY.base)
    : (process.env.ERC8004_REGISTRY_CELO_SEPOLIA || DEFAULT_REGISTRY.sepolia);

  console.log(`🪪 setAgentURI on ${networkName}`);
  console.log(`📇 Registry: ${registryAddress}`);
  console.log(`🔢 Agent ID: ${agentId}`);
  console.log(`🔗 New URI: ${newURI}`);

  const signer = (await hre.ethers.getSigners())[0];
  console.log(`👤 Signing from: ${signer.address}`);

  const registry = new hre.ethers.Contract(registryAddress, REGISTRY_ABI, signer);

  const currentURI: string = await registry.tokenURI(agentId);
  console.log(`📄 Current on-chain tokenURI: ${currentURI}`);

  const tx = await registry.setAgentURI(agentId, newURI);
  console.log(`⏳ Tx sent: ${tx.hash} — waiting for confirmation...`);
  const receipt = await tx.wait();

  console.log("\n✅ --- AGENT URI UPDATED --- ✅");
  console.log(`Tx: ${tx.hash}`);
  console.log(`Block: ${receipt?.blockNumber}`);
  console.log(`Check the tx on the block explorer for network "${networkName}", then give 8004scan a few minutes to re-crawl.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
