import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre as any;

/**
 * AbaPayV4 — identical to V3 except the treasury withdrawal timelock is an owner-settable
 * duration instead of a fixed 24h constant. These tests cover ONLY what's different; the
 * shared behavior (allowances, payBillFor bounds, relayer kill switch, pause) is already
 * proven in AbaPayV3.test.ts and is byte-identical here — spot-checked below, not re-proven
 * exhaustively.
 */
describe("AbaPayV4 — owner-adjustable withdrawal delay", function () {
  async function deploy() {
    const [owner, user, relayer, attacker, destination] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy("Mock USD", "mUSD", 6);

    const AbaPay = await ethers.getContractFactory("AbaPayV4");
    const abapay = await AbaPay.deploy(owner.address);
    const abapayAddr = await abapay.getAddress();
    const tokenAddr = await token.getAddress();

    await abapay.setTokenSupport(tokenAddr, true);
    await abapay.setRelayer(relayer.address);
    await abapay.setMaxAgentPayment(tokenAddr, ethers.parseUnits("20", 6));

    await token.mint(user.address, ethers.parseUnits("1000", 6));
    await token.connect(user).approve(abapayAddr, ethers.MaxUint256);

    // Fund the vault directly (as if payments had already come in) so withdrawal tests
    // don't need to route a payment first.
    await token.mint(abapayAddr, ethers.parseUnits("500", 6));

    return { abapay, token, owner, user, relayer, attacker, destination, abapayAddr, tokenAddr };
  }

  describe("default behavior — unchanged from V3", function () {
    it("defaults to a 24 hour delay, same as V3's fixed constant", async function () {
      const { abapay } = await deploy();
      expect(await abapay.withdrawalDelay()).to.equal(24 * 60 * 60);
    });

    it("a queued withdrawal cannot execute before the delay elapses", async function () {
      const { abapay, owner, tokenAddr, destination } = await deploy();
      await abapay.connect(owner).queueWithdrawal(tokenAddr, destination.address, ethers.parseUnits("10", 6));

      await expect(
        abapay.connect(owner).executeWithdrawal(tokenAddr)
      ).to.be.revertedWithCustomError(abapay, "TimelockNotElapsed");
    });

    it("executes once the default 24h delay has elapsed", async function () {
      const { abapay, token, owner, tokenAddr, destination } = await deploy();
      const amount = ethers.parseUnits("10", 6);
      await abapay.connect(owner).queueWithdrawal(tokenAddr, destination.address, amount);

      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      await abapay.connect(owner).executeWithdrawal(tokenAddr);
      expect(await token.balanceOf(destination.address)).to.equal(amount);
    });
  });

  describe("setWithdrawalDelay — the new lever", function () {
    it("only the owner can change the delay", async function () {
      const { abapay, attacker } = await deploy();
      await expect(
        abapay.connect(attacker).setWithdrawalDelay(0)
      ).to.be.revertedWithCustomError(abapay, "OwnableUnauthorizedAccount");
    });

    it("emits WithdrawalDelayUpdated with the previous and new values", async function () {
      const { abapay, owner } = await deploy();
      await expect(abapay.connect(owner).setWithdrawalDelay(3600))
        .to.emit(abapay, "WithdrawalDelayUpdated")
        .withArgs(24 * 60 * 60, 3600);
    });

    it("EMERGENCY CASE: setting the delay to 0 allows immediate queue -> execute", async function () {
      const { abapay, token, owner, tokenAddr, destination } = await deploy();
      await abapay.connect(owner).setWithdrawalDelay(0);

      const amount = ethers.parseUnits("50", 6);
      await abapay.connect(owner).queueWithdrawal(tokenAddr, destination.address, amount);

      // No time skip needed — executableAt == block.timestamp already.
      await abapay.connect(owner).executeWithdrawal(tokenAddr);
      expect(await token.balanceOf(destination.address)).to.equal(amount);
    });

    it("a REDUCED delay only affects withdrawals queued AFTER the change", async function () {
      const { abapay, owner, tokenAddr, destination } = await deploy();

      // Queue under the original 24h delay.
      await abapay.connect(owner).queueWithdrawal(tokenAddr, destination.address, ethers.parseUnits("10", 6));
      const queuedAt = (await ethers.provider.getBlock("latest"))!.timestamp;
      const executableAt = (await abapay.pendingWithdrawals(tokenAddr)).executableAt;
      expect(executableAt).to.equal(BigInt(queuedAt) + BigInt(24 * 60 * 60));

      // Lowering the delay now must NOT retroactively change the already-queued executableAt.
      await abapay.connect(owner).setWithdrawalDelay(60);
      const stillSame = (await abapay.pendingWithdrawals(tokenAddr)).executableAt;
      expect(stillSame).to.equal(executableAt);
    });

    it("delay can be RAISED again after being lowered (routine ops resume real protection)", async function () {
      const { abapay, owner, tokenAddr, destination } = await deploy();
      await abapay.connect(owner).setWithdrawalDelay(0);
      await abapay.connect(owner).setWithdrawalDelay(48 * 60 * 60);
      expect(await abapay.withdrawalDelay()).to.equal(48 * 60 * 60);

      await abapay.connect(owner).queueWithdrawal(tokenAddr, destination.address, ethers.parseUnits("10", 6));
      await expect(
        abapay.connect(owner).executeWithdrawal(tokenAddr)
      ).to.be.revertedWithCustomError(abapay, "TimelockNotElapsed");
    });
  });

  describe("spot-check: core V3 behavior is preserved", function () {
    it("agent CANNOT spend before the user sets an allowance", async function () {
      const { abapay, relayer, user, tokenAddr } = await deploy();
      await expect(
        abapay.connect(relayer).payBillFor(user.address, tokenAddr, "mtn", "080", ethers.parseUnits("1", 6))
      ).to.be.revertedWithCustomError(abapay, "ExceedsSpendingAllowance");
    });

    it("agent pays within allowance and the allowance decrements", async function () {
      const { abapay, token, relayer, user, tokenAddr, abapayAddr } = await deploy();
      await abapay.connect(user).setSpendingAllowance(tokenAddr, ethers.parseUnits("10", 6));

      const before = await token.balanceOf(abapayAddr);
      const amount = ethers.parseUnits("3", 6);
      await abapay.connect(relayer).payBillFor(user.address, tokenAddr, "mtn", "08012345678", amount);

      expect(await token.balanceOf(abapayAddr)).to.equal(before + amount);
      expect(await abapay.remainingAllowance(user.address, tokenAddr)).to.equal(ethers.parseUnits("7", 6));
    });

    it("a stolen relayer key still cannot withdraw the vault (only the owner can)", async function () {
      const { abapay, relayer, tokenAddr } = await deploy();
      await expect(
        abapay.connect(relayer).queueWithdrawal(tokenAddr, relayer.address, 1)
      ).to.be.revertedWithCustomError(abapay, "OwnableUnauthorizedAccount");
    });

    it("owner can still kill the relayer instantly", async function () {
      const { abapay, owner, relayer, user, tokenAddr } = await deploy();
      await abapay.connect(user).setSpendingAllowance(tokenAddr, ethers.parseUnits("10", 6));
      await abapay.connect(owner).setRelayer(ethers.ZeroAddress);

      await expect(
        abapay.connect(relayer).payBillFor(user.address, tokenAddr, "mtn", "080", ethers.parseUnits("1", 6))
      ).to.be.revertedWithCustomError(abapay, "RelayerDisabled");
    });
  });
});
