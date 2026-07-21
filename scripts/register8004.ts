import hre from "hardhat";

/**
 * Registers AbaPay's DeAI agent as an on-chain identity via ERC-8004 (Trustless Agents),
 * so it's discoverable on 8004scan.io / AgentScan. Run once per chain — Celo and Base each
 * get their OWN agent ID (identity is per-chain; there is no cross-chain agent record).
 *
 * This is identity-only — it does NOT touch payments. The relayer's existing
 * signature-free bill-pay flow (contracts/AbaPayV3.sol, src/lib/deai/relayer.ts) is
 * completely unaffected by this script.
 *
 * Registry addresses (third-party, AbaPay does not control them — env-overridable):
 *   - Celo mainnet:  0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
 *   - Celo Sepolia:  0x8004A818BFB912233c491871b3d84c89A494BD9e
 *   - Base mainnet:  0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 (SAME address as Celo mainnet —
 *     confirmed on-chain via `eth_getCode`, byte-identical bytecode on both chains, consistent
 *     with a canonical CREATE2 deployment of the reference ERC-8004 registry. Verified directly
 *     against the RPC, not assumed from documentation.)
 *
 * ⚠️ Before running on mainnet, confirm `register(string)` is the correct selector against
 * the verified implementation source on the block explorer for the address above — this
 * script assumes the single-argument overload from the ERC-8004 reference contracts.
 *
 * Usage:
 *   ERC8004_AGENT_URI=https://abapays.com/.well-known/agent.json \
 *     npx hardhat run scripts/register8004.ts --network sepolia
 *   (then, once verified) --network celo
 *   (and separately, for a Base identity) --network base
 */

const REGISTRY_ABI = [
  {
    inputs: [{ internalType: "string", name: "agentURI", type: "string" }],
    name: "register",
    outputs: [{ internalType: "uint256", name: "agentId", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  // Standard ERC-721 mint event — the registry mints the agent identity as an NFT,
  // so this is how we recover the tokenId (= agent ID) from the receipt.
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "from", type: "address" },
      { indexed: true, internalType: "address", name: "to", type: "address" },
      { indexed: true, internalType: "uint256", name: "tokenId", type: "uint256" },
    ],
    name: "Transfer",
    type: "event",
  },
];

const DEFAULT_REGISTRY: Record<string, string> = {
  celo: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  sepolia: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  base: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", // same address as celo — see header note
};

async function main() {
  const networkName = hre.network.name;
  console.log(`🪪 Registering AbaPay's agent identity on ERC-8004 (${networkName})...`);

  const agentURI = process.env.ERC8004_AGENT_URI;
  if (!agentURI) {
    throw new Error(
      "Set ERC8004_AGENT_URI to the public HTTPS URL of the agent card " +
      "(e.g. https://abapays.com/.well-known/agent.json) before running this script."
    );
  }

  const registryAddress =
    networkName === "celo" ? (process.env.ERC8004_REGISTRY_CELO_MAINNET || DEFAULT_REGISTRY.celo)
    : networkName === "base" ? (process.env.ERC8004_REGISTRY_BASE_MAINNET || DEFAULT_REGISTRY.base)
    : (process.env.ERC8004_REGISTRY_CELO_SEPOLIA || DEFAULT_REGISTRY.sepolia);

  console.log(`📇 Registry: ${registryAddress}`);
  console.log(`🔗 Agent card: ${agentURI}`);

  const signer = (await hre.ethers.getSigners())[0];
  console.log(`👤 Registering from: ${signer.address}`);

  const registry = new hre.ethers.Contract(registryAddress, REGISTRY_ABI, signer);

  const tx = await registry.register(agentURI);
  console.log(`⏳ Tx sent: ${tx.hash} — waiting for confirmation...`);
  const receipt = await tx.wait();

  // The registry mints the agent identity as an ERC-721, so the tokenId in the Transfer
  // (from the zero address) log is the agent ID.
  let agentId: string | undefined;
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = registry.interface.parseLog(log);
      if (parsed?.name === "Transfer" && parsed.args.from === hre.ethers.ZeroAddress) {
        agentId = parsed.args.tokenId.toString();
        break;
      }
    } catch {
      // Not a log this ABI can decode — skip.
    }
  }

  console.log("\n🎉 --- AGENT REGISTERED --- 🎉");
  console.log(`Tx: ${tx.hash}`);
  if (agentId) console.log(`Agent ID: ${agentId}`);
  console.log(
    `\nCheck the mint log on the block explorer for the exact tokenId, then:\n` +
    `  1. Set NEXT_PUBLIC_ERC8004_AGENT_ID=<agentId> in your env.\n` +
    `  2. Look up the agent on https://8004scan.io once indexed.\n` +
    `  3. Confirm receipt logs at the explorer for network "${networkName}".`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
