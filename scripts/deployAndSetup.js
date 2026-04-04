const hre = require("hardhat");

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
  let usdt, usdc;
  if (networkName === "celo") {
    // MAINNET ADDRESSES
    usdt = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";
    usdc = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
  } else {
    // SEPOLIA TESTNET ADDRESSES
    usdt = "0xd077A400968890Eacc75cdc901F0356c943e4fDb";
    usdc = "0x01C5C0122039549AD1493B8220cABEdD739BC44E";
  }

  // 3. Whitelist the Tokens
  console.log("🔐 Whitelisting Stablecoins...");
  let tx1 = await AbaPay.setTokenSupport(usdt, true);
  await tx1.wait();
  console.log("✅ USDT Whitelisted");

  let tx2 = await AbaPay.setTokenSupport(usdc, true);
  await tx2.wait();
  console.log("✅ USDC Whitelisted");

  console.log("\n🎉 --- DEPLOYMENT & SETUP COMPLETE --- 🎉");
  console.log(`To verify your contract, run the following command:`);
  console.log(`npx hardhat verify --network ${networkName} ${contractAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});