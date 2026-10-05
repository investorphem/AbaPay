import { expect } from "chai";
import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const { ethers, network } = hre;

// The exact table production signs x402 payments with, not a copy. Loaded with require because
// Node runs this file as native ESM, which needs an explicit .ts extension TypeScript won't accept.
const { X402_DOMAINS_BY_CHAIN } = createRequire(import.meta.url)("../../src/lib/x402Domains.ts") as typeof import("../../src/lib/x402Domains");

/**
 * 🍴 NIGHTLY FORK TESTS (M7). The unit tests prove the vault against a mock ERC-20; these prove the
 * DEPLOYED vaults against the REAL token contracts, on a fork of Celo or Base at its latest block:
 *
 *   • the vault's live configuration is what config/vaults.json says it should be
 *   • payBill / payBillFor move real USDC / USD₮ / USA₮ exactly, and the bounds still hold
 *   • the USDm decimals attack (pay 10^6 base units of an 18-decimal token, be credited as if it
 *     were 1 USDC) reverts, because M0.3 switched USDm support off
 *   • every EIP-712 domain x402 signs with (src/lib/x402Domains.ts) matches the token's own
 *     DOMAIN_SEPARATOR, and a transferWithAuthorization signed with it actually settles
 *
 * Run by scripts/fork-tests.mjs, which sets FORK_CHAIN and the RPC URL. Skipped otherwise, so a
 * plain `npm run test:contracts` is unaffected.
 */

const CHAIN = process.env.FORK_CHAIN as "celo" | "base" | undefined;
const forked = !!CHAIN && !!process.env[`${CHAIN?.toUpperCase()}_FORK_RPC_URL`];

type TokenCfg = { address: string; decimals: number };
type VaultTokenCfg = { supported: boolean; maxRefund?: string; maxAgentPayment?: string };
type VaultCfg = {
  name: string; chain: string; kind: string; address: string; withdrawalDelaySeconds?: number;
  paused?: boolean; relayerEnabled?: boolean; tokens: Record<string, VaultTokenCfg>;
};
const cfg = JSON.parse(fs.readFileSync(path.resolve("config/vaults.json"), "utf8")) as {
  owner: string; relayer: string; tokens: Record<string, Record<string, TokenCfg>>; vaults: VaultCfg[];
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
];
const TRANSFER_WITH_AUTHORIZATION = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};
// OpenZeppelin v5 upgradeable ERC20 keeps balances in an ERC-7201 namespace, not a low slot.
const OZ_ERC20_NAMESPACE = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n;

/** Give `to` exactly `amount` of a real token by finding its balance mapping slot. */
async function fund(token: string, to: string, amount: bigint) {
  const erc20 = await ethers.getContractAt(ERC20_ABI, token);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const slots = [...Array.from({ length: 120 }, (_, i) => BigInt(i)), OZ_ERC20_NAMESPACE];
  for (const slot of slots) {
    const key = ethers.keccak256(coder.encode(["address", "uint256"], [to, slot]));
    const prev = await network.provider.send("eth_getStorageAt", [token, key, "latest"]);
    await network.provider.send("hardhat_setStorageAt", [token, key, ethers.toBeHex(amount, 32)]);
    if ((await erc20.balanceOf(to)) === amount) return;
    await network.provider.send("hardhat_setStorageAt", [token, key, prev]);
  }
  throw new Error(`could not find the balance slot of ${token}`);
}

async function wallet() {
  const w = ethers.Wallet.createRandom().connect(ethers.provider);
  await network.provider.send("hardhat_setBalance", [w.address, "0x56BC75E2D63100000"]); // 100 native
  return w;
}

async function impersonate(address: string) {
  await network.provider.send("hardhat_impersonateAccount", [address]);
  await network.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]);
  return ethers.getSigner(address);
}

const describeFork = forked ? describe : describe.skip;

describeFork(`fork: ${CHAIN} vaults against the real tokens`, function () {
  this.timeout(300_000);
  const chain = CHAIN!;
  const tokens = cfg.tokens[chain];
  const vaults = cfg.vaults.filter((v) => v.chain === chain && v.kind === "v4");
  const units = (symbol: string, whole: string) => ethers.parseUnits(whole, tokens[symbol].decimals);

  // Hardhat knows only Ethereum's hardfork schedule, so it refuses to execute anything AT the
  // (foreign) fork block. One locally mined block on top runs under the configured Cancun rules.
  before(async () => { await network.provider.send("hardhat_mine", ["0x1"]); });

  it("the fork is the real chain", async function () {
    expect(Number((await ethers.provider.getNetwork()).chainId)).to.equal(chain === "celo" ? 42220 : 8453);
    expect(vaults.length).to.be.greaterThan(0);
  });

  for (const v of vaults) {
    describe(v.name, function () {
      const vault = () => ethers.getContractAt("AbaPayV4", v.address);
      const supported = Object.entries(v.tokens).filter(([, t]) => t.supported).map(([s]) => s);
      const unsupported = Object.entries(v.tokens).filter(([, t]) => !t.supported).map(([s]) => s);

      it("has the configuration config/vaults.json expects", async function () {
        const c = await vault();
        expect((await c.owner()).toLowerCase()).to.equal(cfg.owner.toLowerCase());
        if (v.paused !== undefined) expect(await c.paused()).to.equal(v.paused);
        if (v.withdrawalDelaySeconds !== undefined) expect(await c.withdrawalDelay()).to.equal(BigInt(v.withdrawalDelaySeconds));
        const relayer = (await c.relayer()).toLowerCase();
        expect(relayer).to.equal(v.relayerEnabled ? cfg.relayer.toLowerCase() : ethers.ZeroAddress);
        for (const [symbol, t] of Object.entries(v.tokens)) {
          const token = tokens[symbol].address;
          expect(await c.isSupportedToken(token), `${symbol} supported`).to.equal(t.supported);
          if (t.maxRefund) expect(await c.maxRefundPerTx(token), `${symbol} maxRefund`).to.equal(units(symbol, t.maxRefund));
          if (t.maxAgentPayment) expect(await c.maxAgentPaymentPerTx(token), `${symbol} maxAgentPayment`).to.equal(units(symbol, t.maxAgentPayment));
        }
      });

      for (const symbol of supported) {
        it(`payBill takes exactly the amount of real ${symbol} and emits it`, async function () {
          const c = await vault();
          const token = tokens[symbol].address;
          const erc20 = await ethers.getContractAt(ERC20_ABI, token);
          const user = await wallet();
          const amount = units(symbol, "1.5");
          await fund(token, user.address, amount);
          await erc20.connect(user).approve(v.address, amount);

          const before = await erc20.balanceOf(v.address);
          await expect(c.connect(user).payBill(token, "AIRTIME", "08012345678", amount))
            .to.emit(c, "PaymentReceived").withArgs(user.address, ethers.getAddress(token), "AIRTIME", "08012345678", amount);
          expect((await erc20.balanceOf(v.address)) - before).to.equal(amount);
          expect(await erc20.balanceOf(user.address)).to.equal(0n);
        });
      }

      for (const symbol of unsupported) {
        it(`refuses ${symbol} (the decimals attack: 10^6 base units passed off as 1 dollar)`, async function () {
          const c = await vault();
          const attacker = await wallet();
          await expect(c.connect(attacker).payBill(tokens[symbol].address, "AIRTIME", "08012345678", 1_000_000n))
            .to.be.revertedWithCustomError(c, "TokenNotSupported");
        });
      }

      if (v.relayerEnabled) {
        const symbol = supported.find((s) => v.tokens[s].maxAgentPayment) ?? supported[0];
        it(`payBillFor stays inside the user's allowance and the per-payment cap (${symbol})`, async function () {
          const c = await vault();
          const token = tokens[symbol].address;
          const erc20 = await ethers.getContractAt(ERC20_ABI, token);
          const relayer = await impersonate(await c.relayer());
          const user = await wallet();
          const cap = await c.maxAgentPaymentPerTx(token);
          await fund(token, user.address, cap * 3n);
          await erc20.connect(user).approve(v.address, ethers.MaxUint256);
          await c.connect(user).setSpendingAllowance(token, cap + cap / 2n);

          await expect(c.connect(relayer).payBillFor(user.address, token, "DATA", "08012345678", cap))
            .to.emit(c, "AgentPayment").withArgs(user.address, ethers.getAddress(token), cap, cap / 2n);
          await expect(c.connect(relayer).payBillFor(user.address, token, "DATA", "08012345678", cap))
            .to.be.revertedWithCustomError(c, "ExceedsSpendingAllowance");
          await c.connect(user).setSpendingAllowance(token, cap * 2n);
          await expect(c.connect(relayer).payBillFor(user.address, token, "DATA", "08012345678", cap + 1n))
            .to.be.revertedWithCustomError(c, "ExceedsMaxAgentPayment");
          await expect(c.connect(user).payBillFor(user.address, token, "DATA", "08012345678", 1n))
            .to.be.revertedWithCustomError(c, "NotRelayer");
        });
      }
    });
  }

  const domains = X402_DOMAINS_BY_CHAIN[chain === "celo" ? "CELO" : "BASE"];
  for (const [symbol, d] of Object.entries(domains)) {
    describe(`x402 domain for ${symbol} ("${d.name}" v${d.version})`, function () {
      const token = () => tokens[symbol].address;
      const domain = () => ({ name: d.name, version: d.version, chainId: chain === "celo" ? 42220 : 8453, verifyingContract: token() });

      it("matches the token's own DOMAIN_SEPARATOR", async function () {
        const erc20 = await ethers.getContractAt(ERC20_ABI, token());
        expect(await erc20.DOMAIN_SEPARATOR()).to.equal(ethers.TypedDataEncoder.hashDomain(domain()));
      });

      it("settles a transferWithAuthorization signed with it, exactly once", async function () {
        const erc20 = await ethers.getContractAt(ERC20_ABI, token());
        const payer = await wallet();
        const facilitator = await wallet();
        const to = vaults[0]?.address ?? facilitator.address;
        const value = units(symbol, "2");
        await fund(token(), payer.address, value);
        const now = (await ethers.provider.getBlock("latest"))!.timestamp;
        const message = {
          from: payer.address, to, value, validAfter: 0n, validBefore: BigInt(now + 3600),
          nonce: ethers.hexlify(ethers.randomBytes(32)),
        };
        const sig = ethers.Signature.from(await payer.signTypedData(domain(), TRANSFER_WITH_AUTHORIZATION, message));
        const call = () => erc20.connect(facilitator).transferWithAuthorization(
          message.from, message.to, message.value, message.validAfter, message.validBefore, message.nonce, sig.v, sig.r, sig.s);

        const before = await erc20.balanceOf(to);
        await (await call()).wait();
        expect((await erc20.balanceOf(to)) - before).to.equal(value);
        await expect(call()).to.be.reverted; // the nonce is spent
      });
    });
  }
});
