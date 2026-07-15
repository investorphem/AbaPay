import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre as any;

/**
 * AbaPayV3 — the agent/allowance model.
 *
 * These tests exist to PROVE the claims in the contract's NatSpec, because this is the one
 * place where a server-held hot key can move user funds. Every bound must be enforced
 * on-chain, not by our backend.
 */
describe("AbaPayV3 — agent spending allowances", function () {
  async function deploy() {
    const [owner, user, relayer, attacker] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy("Mock USD", "mUSD", 6);

    const AbaPay = await ethers.getContractFactory("AbaPayV3");
    const abapay = await AbaPay.deploy(owner.address);
    const abapayAddr = await abapay.getAddress();
    const tokenAddr = await token.getAddress();

    await abapay.setTokenSupport(tokenAddr, true);
    await abapay.setRelayer(relayer.address);
    await abapay.setMaxAgentPayment(tokenAddr, ethers.parseUnits("20", 6)); // $20 per-tx ceiling

    await token.mint(user.address, ethers.parseUnits("1000", 6));
    // The user grants the standard ERC-20 approval to the vault.
    await token.connect(user).approve(abapayAddr, ethers.MaxUint256);

    return { abapay, token, owner, user, relayer, attacker, abapayAddr, tokenAddr };
  }

  describe("consent", function () {
    it("agent CANNOT spend anything before the user sets an allowance (defaults to 0)", async function () {
      // The single most important test: no consent => no power.
      const { abapay, relayer, user, tokenAddr } = await deploy();
      await expect(
        abapay.connect(relayer).payBillFor(user.address, tokenAddr, "mtn", "080", ethers.parseUnits("1", 6))
      ).to.be.revertedWithCustomError(abapay, "ExceedsSpendingAllowance");
    });

    it("only the USER can set their own allowance — the owner cannot grant it", async function () {
      // A compromised backend/owner must not be able to give itself room to spend.
      const { abapay, owner, user, tokenAddr } = await deploy();
      expect((abapay as any).connect(owner).setSpendingAllowance).to.exist;

      // Owner setting an allowance only affects the OWNER's own allowance, never the user's.
      await abapay.connect(owner).setSpendingAllowance(tokenAddr, ethers.parseUnits("999", 6));
      expect(await abapay.remainingAllowance(user.address, tokenAddr)).to.equal(0);
    });

    it("user can revoke instantly by setting the allowance to 0", async function () {
      const { abapay, relayer, user, tokenAddr } = await deploy();
      await abapay.connect(user).setSpendingAllowance(tokenAddr, ethers.parseUnits("10", 6));

      await abapay.connect(user).setSpendingAllowance(tokenAddr, 0);

      await expect(
        abapay.connect(relayer).payBillFor(user.address, tokenAddr, "mtn", "080", ethers.parseUnits("1", 6))
      ).to.be.revertedWithCustomError(abapay, "ExceedsSpendingAllowance");
    });
  });

  describe("agent payment", function () {
    it("agent CAN pay within the user's allowance, and the allowance decrements", async function () {
      const { abapay, token, relayer, user, tokenAddr, abapayAddr } = await deploy();
      await abapay.connect(user).setSpendingAllowance(tokenAddr, ethers.parseUnits("10", 6));

      const amount = ethers.parseUnits("3", 6);
      await expect(abapay.connect(relayer).payBillFor(user.address, tokenAddr, "mtn", "08012345678", amount))
        .to.emit(abapay, "PaymentReceived")
        .withArgs(user.address, tokenAddr, "mtn", "08012345678", amount);

      // Funds moved from the USER's wallet straight into the vault — never held by AbaPay's backend.
      expect(await token.balanceOf(abapayAddr)).to.equal(amount);
      expect(await abapay.remainingAllowance(user.address, tokenAddr)).to.equal(ethers.parseUnits("7", 6));
    });

    it("REJECTS a payment exceeding the user's remaining allowance", async function () {
      // THE CORE BOUND: a stolen relayer key can never exceed what the user authorised.
      const { abapay, relayer, user, tokenAddr } = await deploy();
      await abapay.connect(user).setSpendingAllowance(tokenAddr, ethers.parseUnits("10", 6));

      await expect(
        abapay.connect(relayer).payBillFor(user.address, tokenAddr, "mtn", "080", ethers.parseUnits("11", 6))
      ).to.be.revertedWithCustomError(abapay, "ExceedsSpendingAllowance");
    });

    it("allowance cannot be drained by repeated small payments beyond the cap", async function () {
      const { abapay, relayer, user, tokenAddr } = await deploy();
      await abapay.connect(user).setSpendingAllowance(tokenAddr, ethers.parseUnits("10", 6));

      const five = ethers.parseUnits("5", 6);
      await abapay.connect(relayer).payBillFor(user.address, tokenAddr, "mtn", "080", five);
      await abapay.connect(relayer).payBillFor(user.address, tokenAddr, "mtn", "080", five);

      // Allowance exhausted — the third attempt must fail even though the user still holds tokens.
      await expect(
        abapay.connect(relayer).payBillFor(user.address, tokenAddr, "mtn", "080", ethers.parseUnits("1", 6))
      ).to.be.revertedWithCustomError(abapay, "ExceedsSpendingAllowance");
    });

    it("REJECTS a payment above the per-transaction ceiling, even within the user's allowance", async function () {
      // Second, independent bound: limits blast radius of a compromised relayer per call.
      const { abapay, relayer, user, tokenAddr } = await deploy();
      await abapay.connect(user).setSpendingAllowance(tokenAddr, ethers.parseUnits("500", 6));

      await expect(
        abapay.connect(relayer).payBillFor(user.address, tokenAddr, "mtn", "080", ethers.parseUnits("50", 6))
      ).to.be.revertedWithCustomError(abapay, "ExceedsMaxAgentPayment");
    });
  });

  describe("relayer authorisation", function () {
    it("a NON-relayer cannot call payBillFor", async function () {
      const { abapay, attacker, user, tokenAddr } = await deploy();
      await abapay.connect(user).setSpendingAllowance(tokenAddr, ethers.parseUnits("10", 6));

      await expect(
        abapay.connect(attacker).payBillFor(user.address, tokenAddr, "mtn", "080", ethers.parseUnits("1", 6))
      ).to.be.revertedWithCustomError(abapay, "NotRelayer");
    });

    it("owner can KILL the relayer instantly — the emergency brake if the hot key leaks", async function () {
      const { abapay, owner, relayer, user, tokenAddr } = await deploy();
      await abapay.connect(user).setSpendingAllowance(tokenAddr, ethers.parseUnits("10", 6));

      await abapay.connect(owner).setRelayer(ethers.ZeroAddress);

      await expect(
        abapay.connect(relayer).payBillFor(user.address, tokenAddr, "mtn", "080", ethers.parseUnits("1", 6))
      ).to.be.revertedWithCustomError(abapay, "RelayerDisabled");
    });

    it("only the owner can set the relayer", async function () {
      const { abapay, attacker } = await deploy();
      await expect(
        abapay.connect(attacker).setRelayer(attacker.address)
      ).to.be.revertedWithCustomError(abapay, "OwnableUnauthorizedAccount");
    });

    it("agent payments are blocked while paused", async function () {
      const { abapay, owner, relayer, user, tokenAddr } = await deploy();
      await abapay.connect(user).setSpendingAllowance(tokenAddr, ethers.parseUnits("10", 6));
      await abapay.connect(owner).pause();

      await expect(
        abapay.connect(relayer).payBillFor(user.address, tokenAddr, "mtn", "080", ethers.parseUnits("1", 6))
      ).to.be.revertedWithCustomError(abapay, "EnforcedPause");
    });
  });

  describe("blast radius of a stolen relayer key", function () {
    it("a stolen relayer key CANNOT drain a user's wallet beyond their allowance", async function () {
      // This is the whole security claim, stated as a test.
      const { abapay, token, relayer, user, tokenAddr } = await deploy();

      const walletBefore = await token.balanceOf(user.address); // 1000
      await abapay.connect(user).setSpendingAllowance(tokenAddr, ethers.parseUnits("10", 6));

      // Attacker has the relayer key and drains everything they possibly can.
      await abapay.connect(relayer).payBillFor(user.address, tokenAddr, "mtn", "080", ethers.parseUnits("10", 6));
      await expect(
        abapay.connect(relayer).payBillFor(user.address, tokenAddr, "mtn", "080", ethers.parseUnits("1", 6))
      ).to.be.reverted;

      const walletAfter = await token.balanceOf(user.address);
      const lost = walletBefore - walletAfter;

      // Maximum possible loss == exactly the allowance the user chose. Nothing more.
      expect(lost).to.equal(ethers.parseUnits("10", 6));
    });

    it("a stolen relayer key CANNOT withdraw the vault", async function () {
      const { abapay, relayer, tokenAddr } = await deploy();
      await expect(
        abapay.connect(relayer).queueWithdrawal(tokenAddr, relayer.address, 1)
      ).to.be.revertedWithCustomError(abapay, "OwnableUnauthorizedAccount");
    });

    it("a stolen relayer key CANNOT raise a user's allowance", async function () {
      const { abapay, relayer, user, tokenAddr } = await deploy();
      // setSpendingAllowance only ever writes to msg.sender's own slot.
      await abapay.connect(relayer).setSpendingAllowance(tokenAddr, ethers.parseUnits("999", 6));
      expect(await abapay.remainingAllowance(user.address, tokenAddr)).to.equal(0);
    });
  });
});
