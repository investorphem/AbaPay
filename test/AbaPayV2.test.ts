import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// `ethers` is NOT a named export of the `hardhat` package. It is attached to the Hardhat
// Runtime Environment at load time by hardhat-ethers (bundled in hardhat-toolbox), so it
// must be read off the HRE rather than imported directly.
const { ethers } = hre as any;

/**
 * AbaPayV2 test suite.
 *
 * These tests exist to prove the security properties claimed in the contract's
 * NatSpec actually hold — especially the ones that protect pooled user funds:
 * access control, the withdrawal timelock, the refund cap, pausing, and
 * reentrancy resistance.
 */
describe("AbaPayV2", function () {
  const ONE_DAY = 24 * 60 * 60;

  async function deploy() {
    const [owner, user, attacker, treasury] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy("Mock USD", "mUSD", 6);

    const AbaPay = await ethers.getContractFactory("AbaPayV2");
    const abapay = await AbaPay.deploy(owner.address);

    // Fund the user and approve the vault.
    await token.mint(user.address, ethers.parseUnits("1000", 6));
    await token.connect(user).approve(await abapay.getAddress(), ethers.MaxUint256);

    await abapay.setTokenSupport(await token.getAddress(), true);

    return { abapay, token, owner, user, attacker, treasury };
  }

  describe("payBill", function () {
    it("accepts payment in a supported token and emits PaymentReceived", async function () {
      const { abapay, token, user } = await deploy();
      const amount = ethers.parseUnits("10", 6);

      await expect(abapay.connect(user).payBill(await token.getAddress(), "mtn", "08012345678", amount))
        .to.emit(abapay, "PaymentReceived")
        .withArgs(user.address, await token.getAddress(), "mtn", "08012345678", amount);

      expect(await abapay.vaultBalance(await token.getAddress())).to.equal(amount);
    });

    it("REJECTS an unsupported token", async function () {
      const { abapay, user } = await deploy();
      const Token = await ethers.getContractFactory("MockERC20");
      const rogue = await Token.deploy("Rogue", "RGE", 18);

      await expect(
        abapay.connect(user).payBill(await rogue.getAddress(), "mtn", "080", 1)
      ).to.be.revertedWithCustomError(abapay, "TokenNotSupported");
    });

    it("REJECTS a zero amount", async function () {
      const { abapay, token, user } = await deploy();
      await expect(
        abapay.connect(user).payBill(await token.getAddress(), "mtn", "080", 0)
      ).to.be.revertedWithCustomError(abapay, "ZeroAmount");
    });

    it("REJECTS payment while paused", async function () {
      const { abapay, token, user } = await deploy();
      await abapay.pause();

      await expect(
        abapay.connect(user).payBill(await token.getAddress(), "mtn", "080", ethers.parseUnits("1", 6))
      ).to.be.revertedWithCustomError(abapay, "EnforcedPause");
    });

    it("resumes payments after unpause", async function () {
      const { abapay, token, user } = await deploy();
      await abapay.pause();
      await abapay.unpause();

      await expect(
        abapay.connect(user).payBill(await token.getAddress(), "mtn", "080", ethers.parseUnits("1", 6))
      ).to.emit(abapay, "PaymentReceived");
    });

    it("emits the ACTUAL received amount for a fee-on-transfer token (not the requested amount)", async function () {
      // This is the bug the balance-delta measurement prevents: with a 10% fee token,
      // V1 would have emitted the full requested amount, causing the backend to vend
      // more value than the vault actually received.
      const { abapay, user } = await deploy();

      const FeeToken = await ethers.getContractFactory("MockFeeToken");
      const feeToken = await FeeToken.deploy(); // takes a 10% fee on transfer
      await feeToken.mint(user.address, ethers.parseUnits("1000", 18));
      await feeToken.connect(user).approve(await abapay.getAddress(), ethers.MaxUint256);
      await abapay.setTokenSupport(await feeToken.getAddress(), true);

      const sent = ethers.parseUnits("100", 18);
      const expectedReceived = (sent * 90n) / 100n;

      await expect(abapay.connect(user).payBill(await feeToken.getAddress(), "mtn", "080", sent))
        .to.emit(abapay, "PaymentReceived")
        .withArgs(user.address, await feeToken.getAddress(), "mtn", "080", expectedReceived);
    });
  });

  describe("access control", function () {
    it("only the owner can whitelist tokens", async function () {
      const { abapay, token, attacker } = await deploy();
      await expect(
        abapay.connect(attacker).setTokenSupport(await token.getAddress(), true)
      ).to.be.revertedWithCustomError(abapay, "OwnableUnauthorizedAccount");
    });

    it("only the owner can pause", async function () {
      const { abapay, attacker } = await deploy();
      await expect(abapay.connect(attacker).pause())
        .to.be.revertedWithCustomError(abapay, "OwnableUnauthorizedAccount");
    });

    it("only the owner can queue a withdrawal", async function () {
      const { abapay, token, attacker } = await deploy();
      await expect(
        abapay.connect(attacker).queueWithdrawal(await token.getAddress(), attacker.address, 1)
      ).to.be.revertedWithCustomError(abapay, "OwnableUnauthorizedAccount");
    });

    it("only the owner can refund", async function () {
      const { abapay, token, attacker } = await deploy();
      await expect(
        abapay.connect(attacker).refundUser(await token.getAddress(), attacker.address, 1, "theft")
      ).to.be.revertedWithCustomError(abapay, "OwnableUnauthorizedAccount");
    });

    it("ownership transfer requires explicit acceptance (Ownable2Step)", async function () {
      const { abapay, owner, user } = await deploy();

      await abapay.connect(owner).transferOwnership(user.address);
      // Still the old owner until accepted — this is what prevents bricking on a typo.
      expect(await abapay.owner()).to.equal(owner.address);

      await abapay.connect(user).acceptOwnership();
      expect(await abapay.owner()).to.equal(user.address);
    });
  });

  describe("withdrawal timelock", function () {
    async function withFunds() {
      const ctx = await deploy();
      await ctx.abapay
        .connect(ctx.user)
        .payBill(await ctx.token.getAddress(), "mtn", "080", ethers.parseUnits("500", 6));
      return ctx;
    }

    it("CANNOT withdraw instantly — the timelock must elapse", async function () {
      // This is the core protection against a compromised owner key draining the vault.
      const { abapay, token, treasury } = await withFunds();
      const amount = ethers.parseUnits("500", 6);

      await abapay.queueWithdrawal(await token.getAddress(), treasury.address, amount);

      await expect(
        abapay.executeWithdrawal(await token.getAddress())
      ).to.be.revertedWithCustomError(abapay, "TimelockNotElapsed");
    });

    it("allows withdrawal after the delay elapses", async function () {
      const { abapay, token, treasury } = await withFunds();
      const amount = ethers.parseUnits("500", 6);

      await abapay.queueWithdrawal(await token.getAddress(), treasury.address, amount);
      await time.increase(ONE_DAY + 1);

      await expect(abapay.executeWithdrawal(await token.getAddress()))
        .to.emit(abapay, "FundsWithdrawn")
        .withArgs(treasury.address, await token.getAddress(), amount);

      expect(await token.balanceOf(treasury.address)).to.equal(amount);
    });

    it("a queued withdrawal can be CANCELLED — the emergency brake", async function () {
      const { abapay, token, treasury } = await withFunds();
      const amount = ethers.parseUnits("500", 6);

      await abapay.queueWithdrawal(await token.getAddress(), treasury.address, amount);
      await expect(abapay.cancelWithdrawal(await token.getAddress()))
        .to.emit(abapay, "WithdrawalCancelled");

      await time.increase(ONE_DAY + 1);
      await expect(
        abapay.executeWithdrawal(await token.getAddress())
      ).to.be.revertedWithCustomError(abapay, "NoPendingWithdrawal");
    });

    it("cannot queue two withdrawals for the same token at once", async function () {
      const { abapay, token, treasury } = await withFunds();
      await abapay.queueWithdrawal(await token.getAddress(), treasury.address, ethers.parseUnits("1", 6));
      await expect(
        abapay.queueWithdrawal(await token.getAddress(), treasury.address, ethers.parseUnits("2", 6))
      ).to.be.revertedWithCustomError(abapay, "WithdrawalAlreadyQueued");
    });

    it("cannot queue more than the vault holds", async function () {
      const { abapay, token, treasury } = await withFunds();
      await expect(
        abapay.queueWithdrawal(await token.getAddress(), treasury.address, ethers.parseUnits("999999", 6))
      ).to.be.revertedWithCustomError(abapay, "InsufficientVaultBalance");
    });
  });

  describe("refunds", function () {
    async function withFunds() {
      const ctx = await deploy();
      await ctx.abapay
        .connect(ctx.user)
        .payBill(await ctx.token.getAddress(), "mtn", "080", ethers.parseUnits("500", 6));
      return ctx;
    }

    it("REJECTS a refund when no cap has been configured (fails closed)", async function () {
      const { abapay, token, user } = await withFunds();
      await expect(
        abapay.refundUser(await token.getAddress(), user.address, ethers.parseUnits("10", 6), "vend failed")
      ).to.be.revertedWithCustomError(abapay, "RefundExceedsCap");
    });

    it("refunds within the cap", async function () {
      const { abapay, token, user } = await withFunds();
      await abapay.setMaxRefund(await token.getAddress(), ethers.parseUnits("50", 6));

      await expect(
        abapay.refundUser(await token.getAddress(), user.address, ethers.parseUnits("10", 6), "vend failed")
      ).to.emit(abapay, "UserRefunded");
    });

    it("REJECTS a refund above the cap — refunds cannot be used to bypass the withdrawal timelock", async function () {
      const { abapay, token, attacker } = await withFunds();
      await abapay.setMaxRefund(await token.getAddress(), ethers.parseUnits("50", 6));

      await expect(
        abapay.refundUser(await token.getAddress(), attacker.address, ethers.parseUnits("500", 6), "drain")
      ).to.be.revertedWithCustomError(abapay, "RefundExceedsCap");
    });

    it("refunds still work while paused (users can be made whole during an incident)", async function () {
      const { abapay, token, user } = await withFunds();
      await abapay.setMaxRefund(await token.getAddress(), ethers.parseUnits("50", 6));
      await abapay.pause();

      await expect(
        abapay.refundUser(await token.getAddress(), user.address, ethers.parseUnits("10", 6), "vend failed")
      ).to.emit(abapay, "UserRefunded");
    });
  });

  describe("reentrancy", function () {
    it("blocks a reentrant token from re-entering payBill", async function () {
      const { abapay, owner } = await deploy();

      const Attacker = await ethers.getContractFactory("ReentrantToken");
      const evil = await Attacker.deploy(await abapay.getAddress());

      // Owner whitelists a malicious hook-bearing token (the realistic mistake scenario).
      await abapay.connect(owner).setTokenSupport(await evil.getAddress(), true);
      await evil.mint(owner.address, ethers.parseUnits("100", 18));

      // The reentrant callback must be rejected by nonReentrant.
      await expect(
        evil.attack(ethers.parseUnits("10", 18))
      ).to.be.reverted;
    });
  });
});
