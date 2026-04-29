import hre from "hardhat";

async function main() {
  const networkName = hre.network.name;
  console.log(`🚀 Starting deployment to ${networkName}...`);

  // 1. Deploy the Contract
  const AbaPay = await hre.ethers.deployContract("AbaPay");
  await AbaPay.waitForDeployment();
  const contractAddress = await AbaPay.getAddress();

  console.log(`✅ AbaPay deployed to: ${contractAddress}`);
  console.log("⏳ Waiting for 5 block confirmations before configuring...");

  // Wait for 5 blocks so the network registers the contract before we write to it
  await AbaPay.deploymentTransaction().wait(5);

  // 2. Define Tokens based on Network
  let tokensToWhitelist = [];

  if (networkName === "celo") {
    console.log("🌍 Configuring for Celo Mainnet...");
    tokensToWhitelist = [
      { name: "USDT", address: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e" },
      { name: "USDC", address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" },
      { name: "cUSD", address: "0x765DE816845861e75A25fCA122bb6898B8B1282a" }
    ];
  } else if (networkName === "base") {
    console.log("🔵 Configuring for Base Mainnet...");
    tokensToWhitelist = [
      // Base uses Native USDC heavily.
      { name: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      // Bridged USDC (USDbC) is also widely used by older protocols
      { name: "USDbC", address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA50fdbb7654" } 
    ];
  } else if (networkName === "baseSepolia") {
    console.log("🧪 Configuring for Base Sepolia Testnet...");
    tokensToWhitelist = [
      // Circle's official Base Sepolia USDC
      { name: "USDC", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }
    ];
  } else {
    // ETH SEPOLIA TESTNET (Fallback)
    console.log("🧪 Configuring for Sepolia Testnet...");
    tokensToWhitelist = [
      { name: "USDT", address: "0xd077A400968890Eacc75cdc901F0356c943e4fDb" },
      { name: "USDC", address: "0x01C5C0122039549AD1493B8220cABEdD739BC44E" },
      { name: "cUSD", address: "0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b" }
    ];
  }

  // 3. Whitelist the Tokens
  console.log("🔐 Whitelisting Stablecoins...");

  for (const token of tokensToWhitelist) {
    if (token.address) {
      let tx = await AbaPay.setTokenSupport(token.address, true);
      await tx.wait();
      console.log(`✅ ${token.name} Whitelisted (${token.address})`);
    }
  }

  console.log("\n🎉 --- DEPLOYMENT & SETUP COMPLETE --- 🎉");
  console.log(`To verify your contract, run the following command:`);
  console.log(`npx hardhat verify --network ${networkName} ${contractAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
