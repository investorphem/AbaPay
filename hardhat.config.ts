import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

// We can reuse your CELO_PRIVATE_KEY for Base, since the same wallet address 
// works across all EVM-compatible chains.
const deployerKey = process.env.CELO_PRIVATE_KEY || process.env.PRIVATE_KEY || "";

const config: HardhatUserConfig = {
  solidity: "0.8.20",
  networks: {
    // CELO TESTNET
    sepolia: {
      url: "https://forno.celo-sepolia.celo-testnet.org",
      accounts: deployerKey ? [deployerKey] : [],
      chainId: 11142220,
    },
    // CELO MAINNET
    celo: {
      url: "https://forno.celo.org",
      accounts: deployerKey ? [deployerKey] : [],
      chainId: 42220,
    },
    // BASE TESTNET
    baseSepolia: {
      url: "https://sepolia.base.org",
      accounts: deployerKey ? [deployerKey] : [],
      chainId: 84532,
    },
    // BASE MAINNET
    base: {
      url: "https://mainnet.base.org",
      accounts: deployerKey ? [deployerKey] : [],
      chainId: 8453,
    },
  },
  // Configuration to verify contracts on Etherscan V2
  etherscan: {
    apiKey: {
      sepolia: process.env.ETHERSCAN_API_KEY || "",
      celo: process.env.ETHERSCAN_API_KEY || "",
      // The Etherscan V2 API usually allows the main ETH key to verify Base as well, 
      // but we add a BASESCAN fallback just in case.
      baseSepolia: process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "",
      base: process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "",
    },
    customChains: [
      {
        network: "sepolia",
        chainId: 11142220,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api", 
          browserURL: "https://sepolia.celoscan.io/",
        },
      },
      {
        network: "celo",
        chainId: 42220,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api", 
          browserURL: "https://celoscan.io/",
        },
      },
      // BASE V2 CONFIGURATION
      {
        network: "baseSepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api", 
          browserURL: "https://sepolia.basescan.org/",
        },
      },
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api", 
          browserURL: "https://basescan.org/",
        },
      }
    ],
  },
};

export default config;
