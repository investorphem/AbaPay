import hre from "hardhat";

/**
 * AbaPayV2 deployment.
 *
 * ⚠️  BEFORE MAINNET:
 *   1. Get a professional smart-contract audit. This contract holds pooled user funds.
 *   2. Set ABAPAY_OWNER to a MULTISIG (e.g. a Safe), not a single EOA. The withdrawal
 *      timelock only protects you if a compromised key cannot unilaterally cancel and
 *      re-queue. With a single-EOA owner, an attacker who steals the key simply waits
 *      out the 24h delay — the timelock buys detection time, nothing more.
 *   3. Deploy to testnet first and run the full flow end-to-end.
 */
async function main() {
  const networkName = hre.network.name;
  console.log(`🚀 Deploying AbaPayV2 to ${networkName}...`);

  // Owner: prefer an explicit multisig address; fall back to the deployer with a warning.
  const deployer = (await hre.ethers.getSigners())[0];
  const owner = process.env.ABAPAY_OWNER || deployer.address;

  if (!process.env.ABAPAY_OWNER) {
    console.warn(
      "\n⚠️  WARNING: ABAPAY_OWNER is not set — deploying with the deployer EOA as owner.\n" +
      "   For production you should set ABAPAY_OWNER to a multisig (Safe) address.\n"
    );
  }
  console.log(`👤 Owner will be: ${owner}`);

  const AbaPay = await hre.ethers.deployContract("AbaPayV2", [owner]);
  await AbaPay.waitForDeployment();
  const contractAddress = await AbaPay.getAddress();

  console.log(`✅ AbaPayV2 deployed to: ${contractAddress}`);
  console.log("⏳ Waiting for 5 block confirmations...");
  await AbaPay.deploymentTransaction().wait(5);

  // ── Token configuration ────────────────────────────────────────────────
  let usdt, usdc, cusd;
  if (networkName === "celo") {
    usdt = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";
    usdc = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
    cusd = "0x765DE816845861e75A25fCA122bb6898B8B1282a";
  } else {
    usdt = "0xd077A400968890Eacc75cdc901F0356c943e4fDb";
    usdc = "0x01C5C0122039549AD1493B8220cABEdD739BC44E";
    cusd = "0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b";
  }

  // NOTE: if ABAPAY_OWNER is a multisig, the calls below will FAIL because the
  // deployer is no longer the owner. In that case, skip them here and execute
  // setTokenSupport / setMaxRefund from the multisig instead.
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log(
      "\nℹ️  Owner is not the deployer, so token configuration must be done FROM THE MULTISIG.\n" +
      "   Execute these calls from the owner account:\n" +
      `     setTokenSupport(${usdt}, true)\n` +
      `     setTokenSupport(${usdc}, true)\n` +
      `     setTokenSupport(${cusd}, true)\n` +
      `     setMaxRefund(<token>, <cap>)   // refunds revert until a cap is set\n`
    );
  } else {
    console.log("🔐 Whitelisting stablecoins...");
    for (const [name, addr] of [["USDT", usdt], ["USDC", usdc], ["cUSD", cusd]]) {
      const tx = await AbaPay.setTokenSupport(addr, true);
      await tx.wait();
      console.log(`   ✅ ${name} whitelisted`);
    }

    // Refunds FAIL CLOSED until a per-token cap is configured. Set sane defaults.
    console.log("🛡️  Setting refund caps...");
    const cap6 = hre.ethers.parseUnits("500", 6);   // USDT / USDC (6 decimals)
    const cap18 = hre.ethers.parseUnits("500", 18); // cUSD (18 decimals)

    for (const [name, addr, cap] of [["USDT", usdt, cap6], ["USDC", usdc, cap6], ["cUSD", cusd, cap18]]) {
      const tx = await AbaPay.setMaxRefund(addr, cap);
      await tx.wait();
      console.log(`   ✅ ${name} max refund set`);
    }
  }

  console.log("\n🎉 --- DEPLOYMENT COMPLETE --- 🎉");
  console.log(`Verify with:\n  npx hardhat verify --network ${networkName} ${contractAddress} ${owner}`);
  console.log(`\nThen update your env:\n  NEXT_PUBLIC_ABAPAY_${networkName.toUpperCase().includes("CELO") ? "CELO" : "BASE"}_ADDRESS=${contractAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});