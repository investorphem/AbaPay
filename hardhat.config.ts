import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

// 🍴 FORK MODE (M7 nightly). With FORK_CHAIN=celo|base and the matching *_FORK_RPC_URL set, the
// in-process Hardhat network becomes a fork of that chain at its latest block, under the real
// chain id, so EIP-712 domains, deployed vaults and token contracts are exactly production's.
// scripts/fork-tests.mjs sets this per chain; without it, Hardhat behaves as before.
const FORKS = {
  celo: { chainId: 42220, url: process.env.CELO_FORK_RPC_URL },
  base: { chainId: 8453, url: process.env.BASE_FORK_RPC_URL },
} as const;
const fork = FORKS[process.env.FORK_CHAIN as keyof typeof FORKS];

const config: HardhatUserConfig = {
  solidity: "0.8.20",
  networks: {
    ...(fork?.url
      ? {
          hardhat: {
            chainId: fork.chainId,
            hardfork: "cancun",
            forking: { url: fork.url },
          },
        }
      : {}),
    // TESTNET (The new Celo Sepolia Testnet)
    sepolia: {
      url: "https://forno.celo-sepolia.celo-testnet.org",
      accounts: process.env.CELO_PRIVATE_KEY ? [process.env.CELO_PRIVATE_KEY] : [],
      chainId: 11142220,
    },
    // MAINNET
    celo: {
      url: "https://forno.celo.org",
      accounts: process.env.CELO_PRIVATE_KEY ? [process.env.CELO_PRIVATE_KEY] : [],
      chainId: 42220,
    },
    // BASE MAINNET — same deployer key (CELO_PRIVATE_KEY is the generic deployer EOA).
    base: {
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      accounts: process.env.CELO_PRIVATE_KEY ? [process.env.CELO_PRIVATE_KEY] : [],
      chainId: 8453,
    },
    // BASE TESTNET (Sepolia)
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      accounts: process.env.CELO_PRIVATE_KEY ? [process.env.CELO_PRIVATE_KEY] : [],
      chainId: 84532,
    },
  },
  // Configuration to verify contracts on Etherscan V2
  etherscan: {
    // Etherscan V2 uses a single unified API key across all chains.
    apiKey: process.env.ETHERSCAN_API_KEY || "",
    customChains: [
      {
        network: "sepolia",
        chainId: 11142220,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api", // FIXED: Etherscan V2 Endpoint
          browserURL: "https://sepolia.celoscan.io/",
        },
      },
      {
        network: "celo",
        chainId: 42220,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api", // FIXED: Etherscan V2 Endpoint
          browserURL: "https://celoscan.io/",
        },
      },
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api", // Etherscan V2 unified endpoint
          browserURL: "https://basescan.org/",
        },
      },
      {
        network: "baseSepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://sepolia.basescan.org/",
        },
      },
    ],
  },
};

export default config;