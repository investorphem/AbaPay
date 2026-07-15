import hre from "hardhat";

/**
 * AbaPayV3 deployment.
 *
 * ⚠️  NOT AUDITED (see contracts/AbaPayV3.sol). Caps below are deliberately small
 *     ($10-equivalent per token) to bound the relayer's blast radius until an audit
 *     is done. Raise them later via setMaxAgentPayment / setMaxRefund once confident.
 *
 *   - Owner: ABAPAY_OWNER if set, else the deployer EOA.
 *   - Relayer: RELAYER_ADDRESS if set, else derived from RELAYER_PRIVATE_KEY.
 *              This must be the same key configured as RELAYER_PRIVATE_KEY in the
 *              app's env — that's the hot key that calls payBillFor().
 */
async function main() {
  const networkName = hre.network.name;
  console.log(`🚀 Deploying AbaPayV3 to ${networkName}...`);

  const deployer = (await hre.ethers.getSigners())[0];
  const owner = process.env.ABAPAY_OWNER || deployer.address;

  if (!process.env.ABAPAY_OWNER) {
    console.warn(
      "\n⚠️  WARNING: ABAPAY_OWNER is not set — deploying with the deployer EOA as owner.\n"
    );
  }
  console.log(`👤 Owner will be: ${owner}`);

  // Resolve the relayer address (the agent's hot key) without ever handling its private key here.
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

  const AbaPay = await hre.ethers.deployContract("AbaPayV3", [owner]);
  await AbaPay.waitForDeployment();
  const contractAddress = await AbaPay.getAddress();

  console.log(`✅ AbaPayV3 deployed to: ${contractAddress}`);
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

  const tokens: [string, string, number][] = [
    ["USDT", usdt, 6],
    ["USDC", usdc, 6],
    ["cUSD", cusd, 18],
  ];

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

    // Small caps while unaudited — see contracts/AbaPayV3.sol header.
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
