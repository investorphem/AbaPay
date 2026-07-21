import hre from "hardhat";

/**
 * AbaPayV4 deployment.
 *
 * V4 == V3, with the treasury withdrawal timelock as an owner-adjustable duration
 * (`withdrawalDelay`, default 24h) instead of a fixed constant — see contracts/AbaPayV4.sol
 * for the full rationale and trade-off notes. Everything else (payBillFor, allowances,
 * per-tx caps, refund caps, pause) is identical to V3.
 *
 * ⚠️  NOT AUDITED (same caveat as V3). Caps below are deliberately small
 *     ($10-equivalent per token) to bound the relayer's blast radius until an audit
 *     is done. Raise them later via setMaxAgentPayment / setMaxRefund once confident.
 *
 *   - Owner: ABAPAY_OWNER if set, else the deployer EOA.
 *   - Relayer: RELAYER_ADDRESS if set, else derived from RELAYER_PRIVATE_KEY.
 *              This must be the same key configured as RELAYER_PRIVATE_KEY in the
 *              app's env — that's the hot key that calls payBillFor().
 *
 * Run with: npx hardhat run scripts/deployV4.ts --network <celo|base|sepolia|baseSepolia>
 */
async function main() {
  const networkName = hre.network.name;
  console.log(`🚀 Deploying AbaPayV4 to ${networkName}...`);

  const deployer = (await hre.ethers.getSigners())[0];
  const owner = process.env.ABAPAY_OWNER || deployer.address;

  if (!process.env.ABAPAY_OWNER) {
    console.warn(
      "\n⚠️  WARNING: ABAPAY_OWNER is not set — deploying with the deployer EOA as owner.\n"
    );
  }
  console.log(`👤 Owner will be: ${owner}`);

  let relayerAddress = process.env.RELAYER_ADDRESS;
  if (!relayerAddress && process.env.RELAYER_PRIVATE_KEY) {
    relayerAddress = new hre.ethers.Wallet(process.env.RELAYER_PRIVATE_KEY).address;
  }
  if (!relayerAddress) {
    throw new Error(
      "Set RELAYER_ADDRESS (preferred) or RELAYER_PRIVATE_KEY in .env.local so the deploy script " +
      "knows which address to authorise as the agent relayer."
    );
  }
  console.log(`🤖 Relayer will be: ${relayerAddress}`);

  const AbaPay = await hre.ethers.deployContract("AbaPayV4", [owner]);
  await AbaPay.waitForDeployment();
  const contractAddress = await AbaPay.getAddress();

  console.log(`✅ AbaPayV4 deployed to: ${contractAddress}`);
  console.log("⏳ Waiting for 5 block confirmations...");
  await AbaPay.deploymentTransaction().wait(5);

  // ── Token configuration ────────────────────────────────────────────────
  // Same per-network token maps as deployV3.ts. Base has NO Mento cUSD/USDm.
  let tokens: [string, string, number][];
  if (networkName === "celo") {
    tokens = [
      ["USDT", "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e", 6],
      ["USDC", "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", 6],
      ["cUSD", "0x765DE816845861e75A25fCA122bb6898B8B1282a", 18],
    ];
  } else if (networkName === "base") {
    tokens = [
      ["USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6],
      ["USDT", "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", 6],
    ];
  } else if (networkName === "baseSepolia") {
    tokens = [
      ["USDC", "0x036CbD53842c5426634e7929541eC2318f3dCF7e", 6],
    ];
  } else {
    // Celo Sepolia
    tokens = [
      ["USDT", "0xd077A400968890Eacc75cdc901F0356c943e4fDb", 6],
      ["USDC", "0x01C5C0122039549AD1493B8220cABEdD739BC44E", 6],
      ["cUSD", "0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b", 18],
    ];
  }

  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log(
      "\nℹ️  Owner is not the deployer, so all configuration below must be done FROM THE OWNER.\n" +
      "   Execute these calls from the owner account:\n" +
      tokens.map(([name, addr]) => `     setTokenSupport(${addr}, true)   // ${name}`).join("\n") +
      `\n     setRelayer(${relayerAddress})\n` +
      tokens.map(([name, addr, decimals]) =>
        `     setMaxAgentPayment(${addr}, ${hre.ethers.parseUnits("10", decimals)})   // ${name}, $10-equivalent`
      ).join("\n") +
      "\n" +
      tokens.map(([name, addr, decimals]) =>
        `     setMaxRefund(${addr}, ${hre.ethers.parseUnits("10", decimals)})   // ${name}, $10-equivalent`
      ).join("\n")
    );
  } else {
    console.log("🔐 Whitelisting stablecoins...");
    for (const [name, addr] of tokens) {
      const tx = await AbaPay.setTokenSupport(addr, true);
      await tx.wait();
      console.log(`   ✅ ${name} whitelisted`);
    }

    console.log(`🤖 Authorising relayer (${relayerAddress})...`);
    const relayerTx = await AbaPay.setRelayer(relayerAddress);
    await relayerTx.wait();
    console.log("   ✅ Relayer set");

    // Small caps while unaudited — see contracts/AbaPayV4.sol header.
    console.log("🛡️  Setting per-tx caps ($10-equivalent per token)...");
    for (const [name, addr, decimals] of tokens) {
      const cap = hre.ethers.parseUnits("10", decimals);

      const agentTx = await AbaPay.setMaxAgentPayment(addr, cap);
      await agentTx.wait();
      console.log(`   ✅ ${name} max agent payment set to $10-equivalent`);

      const refundTx = await AbaPay.setMaxRefund(addr, cap);
      await refundTx.wait();
      console.log(`   ✅ ${name} max refund set to $10-equivalent`);
    }
  }

  console.log(`\n⏱️  withdrawalDelay defaults to 24h, same as V3. Change it any time with:`);
  console.log(`     setWithdrawalDelay(<seconds>)   // 0 = instant, for genuine emergencies only`);

  console.log("\n🎉 --- DEPLOYMENT COMPLETE --- 🎉");
  console.log(`Verify with:\n  npx hardhat verify --network ${networkName} ${contractAddress} ${owner}`);
  console.log(
    `\nThen update your env:\n  NEXT_PUBLIC_ABAPAY_${networkName.toUpperCase().includes("CELO") ? "CELO" : "BASE"}_ADDRESS=${contractAddress}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
