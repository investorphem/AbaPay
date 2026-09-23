import hre from "hardhat";

/**
 * Declares AbaPay's ERC-8004 identity's operational wallet ON-CHAIN, via the registry's own
 * `setAgentWallet` — the correct replacement for the off-chain `agent.json` wallet entries
 * that were deliberately dropped (WA083 marks off-chain `agentWallet` metadata deprecated).
 *
 * WHY THIS SCRIPT EXISTS: `register8004.ts`'s signer (CELO_PRIVATE_KEY, the generic deployer
 * EOA) becomes the registry's implicit `agentWallet` at registration time — see
 * `register(string)` in the verified source, which sets `_metadata[agentId]["agentWallet"] =
 * abi.encodePacked(msg.sender)`. That's the deployer key, NOT the wallet that actually executes
 * agent-initiated payments (RELAYER_ADDRESS, src/lib/deai/relayer.ts) — which is exactly why
 * 8004scan shows the wrong wallet for this identity. This script corrects it.
 *
 * VERIFIED AGAINST THE REAL SOURCE, not guessed — fetched from Sourcify
 * (repo.sourcify.dev, full_match) for the registry's implementation contract
 * (0x7274e874CA62410a93Bd8bf61c69d8045E399c02 on Celo mainnet at the time of writing):
 *
 *   bytes32 constant AGENT_WALLET_SET_TYPEHASH =
 *     keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");
 *   EIP712 domain: name "ERC8004IdentityRegistry", version "1" (set in initialize()).
 *   MAX_DEADLINE_DELAY = 5 minutes — the deadline must be within 5 minutes of the block that
 *   mines this transaction, or the contract reverts with "deadline too far" / "expired".
 *
 * TWO SIGNERS, TWO DIFFERENT ROLES:
 *   1. The TRANSACTION SENDER must be the agent owner (or approved) — CELO_PRIVATE_KEY, same
 *      key hardhat.config.ts already uses for every network here.
 *   2. The EIP-712 SIGNATURE must come from the NEW wallet itself (RELAYER_PRIVATE_KEY) —
 *      proving that wallet consents to being associated with this identity. The contract
 *      recovers the signer from the signature and reverts ("invalid wallet sig") if it doesn't
 *      match `newWallet` exactly. This is the anti-spoofing check the old off-chain JSON field
 *      never had — anyone could previously CLAIM any address was their agent's wallet.
 *
 * Usage — TEST ON SEPOLIA FIRST, same two-phase pattern as register8004.ts:
 *   ERC8004_AGENT_ID=<sepolia test id> npx hardhat run scripts/setAgentWallet.ts --network sepolia
 *   (then, once verified) ERC8004_AGENT_ID=9687  npx hardhat run scripts/setAgentWallet.ts --network celo
 *   ERC8004_AGENT_ID=59561 npx hardhat run scripts/setAgentWallet.ts --network base
 * Optional: ERC8004_NEW_WALLET to override the default (RELAYER_ADDRESS from env).
 */

const REGISTRY_ABI = [
  {
    inputs: [
      { internalType: "uint256", name: "agentId", type: "uint256" },
      { internalType: "address", name: "newWallet", type: "address" },
      { internalType: "uint256", name: "deadline", type: "uint256" },
      { internalType: "bytes", name: "signature", type: "bytes" },
    ],
    name: "setAgentWallet",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "agentId", type: "uint256" }],
    name: "getAgentWallet",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "agentId", type: "uint256" }],
    name: "ownerOf",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "agentId", type: "uint256" },
      { indexed: true, internalType: "string", name: "indexedMetadataKey", type: "string" },
      { indexed: false, internalType: "string", name: "metadataKey", type: "string" },
      { indexed: false, internalType: "bytes", name: "metadataValue", type: "bytes" },
    ],
    name: "MetadataSet",
    type: "event",
  },
];

// Same registry addresses register8004.ts / update8004uri.ts use.
const DEFAULT_REGISTRY: Record<string, string> = {
  celo: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  sepolia: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  base: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
};

async function main() {
  const networkName = hre.network.name;
  console.log(`🪪 Setting AbaPay's ERC-8004 agent wallet on-chain (${networkName})...`);

  const agentId = process.env.ERC8004_AGENT_ID;
  if (!agentId || !/^\d+$/.test(agentId)) {
    throw new Error(
      "Set ERC8004_AGENT_ID to this chain's live agent ID (Celo: 9687, Base: 59561) before running this script."
    );
  }

  const relayerKey = process.env.RELAYER_PRIVATE_KEY;
  if (!relayerKey) {
    throw new Error("RELAYER_PRIVATE_KEY must be set — the new wallet's own key signs the EIP-712 consent message.");
  }
  const relayerWallet = new hre.ethers.Wallet(relayerKey);
  const newWallet = process.env.ERC8004_NEW_WALLET || relayerWallet.address;
  if (newWallet.toLowerCase() !== relayerWallet.address.toLowerCase()) {
    throw new Error(
      `ERC8004_NEW_WALLET (${newWallet}) doesn't match RELAYER_PRIVATE_KEY's address (${relayerWallet.address}) — ` +
      `the signature must come from the exact wallet being set, or the contract rejects it as "invalid wallet sig".`
    );
  }

  const registryAddress =
    networkName === "celo" ? (process.env.ERC8004_REGISTRY_CELO_MAINNET || DEFAULT_REGISTRY.celo)
    : networkName === "base" ? (process.env.ERC8004_REGISTRY_BASE_MAINNET || DEFAULT_REGISTRY.base)
    : (process.env.ERC8004_REGISTRY_CELO_SEPOLIA || DEFAULT_REGISTRY.sepolia);

  console.log(`📇 Registry: ${registryAddress}`);
  console.log(`🪪 Agent ID: ${agentId}`);
  console.log(`👛 New wallet: ${newWallet}`);

  const ownerSigner = (await hre.ethers.getSigners())[0];
  console.log(`👤 Sending from (must be the agent owner): ${ownerSigner.address}`);

  const registry = new hre.ethers.Contract(registryAddress, REGISTRY_ABI, ownerSigner);

  const currentOwner: string = await registry.ownerOf(agentId);
  if (currentOwner.toLowerCase() !== ownerSigner.address.toLowerCase()) {
    throw new Error(
      `On-chain owner of agent ${agentId} is ${currentOwner}, not the configured signer ${ownerSigner.address}. ` +
      `setAgentWallet would revert with "Not authorized".`
    );
  }

  const currentWallet: string = await registry.getAgentWallet(agentId);
  console.log(`ℹ️  Current on-chain wallet: ${currentWallet}`);

  const provider = ownerSigner.provider;
  const latestBlock = await provider.getBlock("latest");
  // Contract enforces deadline <= block.timestamp + 5 minutes at mine time — 4 minutes of
  // headroom from the time we fetch this leaves margin for the tx to actually confirm within
  // the window rather than expiring mid-flight.
  const deadline = BigInt(latestBlock!.timestamp) + 240n;

  const network = await provider.getNetwork();
  const domain = {
    name: "ERC8004IdentityRegistry",
    version: "1",
    chainId: network.chainId,
    verifyingContract: registryAddress,
  };
  const types = {
    AgentWalletSet: [
      { name: "agentId", type: "uint256" },
      { name: "newWallet", type: "address" },
      { name: "owner", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const value = {
    agentId: BigInt(agentId),
    newWallet,
    owner: currentOwner,
    deadline,
  };

  console.log(`✍️  Signing EIP-712 consent from the new wallet itself (deadline: ${deadline})...`);
  const signature = await relayerWallet.signTypedData(domain, types, value);

  const tx = await registry.setAgentWallet(agentId, newWallet, deadline, signature);
  console.log(`⏳ Tx sent: ${tx.hash} — waiting for confirmation...`);
  const receipt = await tx.wait();

  const emitted = (receipt?.logs ?? []).some((log: any) => {
    try {
      return registry.interface.parseLog(log)?.name === "MetadataSet";
    } catch {
      return false;
    }
  });

  console.log(`\n${emitted ? "🎉" : "⚠️"} --- ${emitted ? "AGENT WALLET SET" : "TX CONFIRMED (MetadataSet not found in logs — check manually)"} --- `);
  console.log(`Tx: ${tx.hash}`);
  console.log(
    `\nGive the indexer a few minutes, then check https://8004scan.io/agents/${networkName === "base" ? "base" : "celo"}/${agentId} ` +
    `for the corrected wallet.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
