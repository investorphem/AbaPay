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
  },
  // Configuration to verify contracts on Etherscan V2
  etherscan: {
    // Now using the unified ETHERSCAN_API_KEY for all networks
    apiKey: {
      sepolia: process.env.ETHERSCAN_API_KEY || "",
      celo: process.env.ETHERSCAN_API_KEY || "",
    },
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
    ],
  },
};

export default config;