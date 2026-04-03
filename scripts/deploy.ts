const { ethers, network } = require("hardhat");

async function main() {
  console.log(`Deploying AbaPay to ${network.name}...`);

  let usdtAddress = "";

  if (network.name === "sepolia") {
    // Official Celo Sepolia Testnet USDT
    usdtAddress = "0xd077A400968890Eacc75cdc901F0356c943e4fDb";
  } else if (network.name === "celo") {
    // Official Celo Mainnet USDT
    usdtAddress = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";
  } else {
    throw new Error("Unsupported network!");
  }

  const AbaPay = await ethers.getContractFactory("AbaPay");
  const abaPay = await AbaPay.deploy(usdtAddress);
  
  await abaPay.waitForDeployment();

  console.log(`✅ AbaPay successfully deployed to: ${await abaPay.getAddress()}`);
  console.log(`Network: ${network.name}`);
  console.log(`Used USDT Address: ${usdtAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});