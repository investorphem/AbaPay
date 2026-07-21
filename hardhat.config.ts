import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const config: HardhatUserConfig = {
  solidity: "0.8.20",
  networks: {
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