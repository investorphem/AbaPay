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
  let usdt, usdc, cusd;
  if (networkName === "celo") {
    // MAINNET ADDRESSES
    usdt = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";
    // SEPOLIA TESTNET ADDRESSES
    usdt = "0xd077A400968890Eacc75cdc901F0356c943e4fDb";
  let tx2 = await AbaPay.setTokenSupport(usdc, true);
  await tx2.wait();
  console.log("✅ USDC Whitelisted");

  // Whitelist the new cUSD token
  let tx3 = await AbaPay.setTokenSupport(cusd, true);
  await tx3.wait();
  console.log("✅ cUSD Whitelisted");

  console.log("\n🎉 --- DEPLOYMENT & SETUP COMPLETE --- 🎉");
  console.log(`To verify your contract, run the following command:`);
  console.log(`npx hardhat verify --network ${networkName} ${contractAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});