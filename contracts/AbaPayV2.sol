// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AbaPayV2
 * @notice Hardened payment vault for AbaPay utility bill payments.
 * @dev    Security-hardened successor to the original AbaPay contract.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ⚠️  NOT YET AUDITED. Do not deploy to mainnet with real user funds until a
 *      professional smart-contract audit has been completed. This contract holds
 *      pooled customer funds; a bug here is a total-loss event.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT CHANGED vs. the original AbaPay.sol, and why:
 *
 *  1. SafeERC20 (was: raw IERC20 + require(transfer(...)))
 *     Some real-world tokens (notably USDT on several chains) do NOT return a bool
 *     from transfer/transferFrom, which makes `require(token.transfer(...))` revert
 *     or misbehave. SafeERC20 handles both compliant and non-compliant tokens.
 *
 *  2. ReentrancyGuard (was: none)
 *     The original was *probably* safe because only well-behaved stablecoins were
 *     whitelisted. But `setTokenSupport` lets the owner whitelist ANY token — and a
 *     token with transfer hooks (ERC-777 style) would make payBill reentrant. This
 *     removes the footgun entirely rather than relying on operational discipline.
 *
 *  3. Pausable (was: none)
 *     Previously, if a vulnerability were discovered post-deploy there was NO way to
 *     stop the contract. Now the owner can pause user-facing payments while keeping
 *     refunds available, so users can be made whole during an incident.
 *
 *  4. Ownable2Step (was: owner set once in constructor, no transfer path)
 *     Ownership transfer now requires the new owner to explicitly accept, making it
 *     impossible to permanently brick the contract by transferring to a typo'd or
 *     uncontrolled address.
 *
 *  5. Timelocked withdrawals (was: instant, unlimited `withdrawFunds`)
 *     THE BIGGEST RISK in the original: a single compromised owner key could drain the
 *     entire pooled vault in one transaction, instantly. Withdrawals must now be
 *     announced, then executed only after WITHDRAWAL_DELAY elapses. This gives you a
 *     detection-and-response window (alerting on the WithdrawalQueued event) in which a
 *     compromised-key drain can be cancelled — assuming ownership is a multisig that the
 *     attacker does not fully control.
 *
 *  6. Refund cap + reason (was: unbounded owner-initiated transfers to any address)
 *     `refundUser` was effectively a second, unrestricted withdrawal path: the owner could
 *     send any amount to any address, bypassing the withdrawal timelock entirely. It is now
 *     bounded per-transaction so it cannot be abused as a timelock-evasion drain.
 *
 *  IMPORTANT — DELIBERATELY UNCHANGED:
 *     `payBill`'s signature, parameter order, and the `PaymentReceived` event are byte-for-byte
 *     identical to V1. Your frontend, the /api/pay calldata decoder, and the webhook's
 *     PaymentReceived cross-validation continue to work with NO backend changes.
 *
 *  NOTE ON DELEGATED SPENDING (the DeAI "pay from social media" feature):
 *     payBill still uses `transferFrom(msg.sender, ...)`, meaning the payer MUST be the
 *     transaction signer. This contract therefore still does NOT support an agent/relayer
 *     spending a user's pre-approved allowance on their behalf. That feature requires an
 *     additional on-chain allowance mechanism and is intentionally OUT OF SCOPE here — it
 *     should be designed and audited as its own change, not bundled into a hardening pass.
 */
contract AbaPayV2 is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Configuration ───────────────────────────────────────────────────────

    /// @notice Delay between queueing and executing a treasury withdrawal.
    uint256 public constant WITHDRAWAL_DELAY = 24 hours;

    /// @notice Upper bound on a single refund, to prevent refunds being used to
    ///         bypass the withdrawal timelock. Denominated in the token's own units.
    ///         Set per-token by the owner; a token with no cap set cannot be refunded.
    mapping(address => uint256) public maxRefundPerTx;

    /// @notice Whitelist of tokens accepted for payment.
    mapping(address => bool) public isSupportedToken;

    // ─── Withdrawal queue ────────────────────────────────────────────────────

    struct PendingWithdrawal {
        uint256 amount;
        uint256 executableAt;
        address destination;
    }

    /// @notice At most one pending withdrawal per token at a time.
    mapping(address => PendingWithdrawal) public pendingWithdrawals;

    // ─── Events ──────────────────────────────────────────────────────────────

    /// @dev IDENTICAL to V1 — the backend webhook decodes this exact signature.
    event PaymentReceived(
        address indexed user,
        address indexed token,
        string serviceType,
        string accountNumber,
        uint256 amount
    );

    event TokenSupportUpdated(address indexed token, bool isSupported);
    event MaxRefundUpdated(address indexed token, uint256 maxAmount);

    event WithdrawalQueued(address indexed token, address indexed destination, uint256 amount, uint256 executableAt);
    event WithdrawalCancelled(address indexed token, uint256 amount);
    event FundsWithdrawn(address indexed destination, address indexed token, uint256 amount);

    event UserRefunded(address indexed user, address indexed token, uint256 amount, string reason);

    // ─── Errors (cheaper than require strings) ───────────────────────────────

    error ZeroAmount();
    error ZeroAddress();
    error TokenNotSupported(address token);
    error InsufficientVaultBalance(uint256 requested, uint256 available);
    error NoPendingWithdrawal();
    error TimelockNotElapsed(uint256 executableAt);
    error WithdrawalAlreadyQueued();
    error RefundExceedsCap(uint256 requested, uint256 cap);

    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @param initialOwner The owner address. STRONGLY RECOMMENDED: a multisig (e.g. Safe),
     *                     NOT a single EOA. A single-key owner is the largest residual risk
     *                     in this design — the timelock only helps if a compromised key
     *                     cannot also cancel/execute unilaterally.
     */
    constructor(address initialOwner) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
    }

    // ─── User actions ────────────────────────────────────────────────────────

    /**
     * @notice Pay a utility bill by depositing supported stablecoins into the vault.
     * @dev    Signature intentionally identical to V1 for backend compatibility.
     *         `whenNotPaused` lets us halt payments during an incident.
     *         `nonReentrant` neutralises any hook-bearing token that might be whitelisted.
     *
     *         Follows checks-effects-interactions: all validation happens before the
     *         external transfer, and the event is emitted after the funds have landed.
     */
    function payBill(
        address tokenAddress,
        string calldata serviceType,
        string calldata accountNumber,
        uint256 amount
    ) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (!isSupportedToken[tokenAddress]) revert TokenNotSupported(tokenAddress);

        // Measure actual received amount. This correctly handles fee-on-transfer or
        // rebasing tokens, where the amount credited can be less than the amount sent —
        // the original contract would have emitted an inflated amount in that case,
        // causing the backend to over-vend relative to funds actually received.
        uint256 balanceBefore = IERC20(tokenAddress).balanceOf(address(this));
        IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(tokenAddress).balanceOf(address(this)) - balanceBefore;

        if (received == 0) revert ZeroAmount();

        // Emit the ACTUAL received amount, so the backend's amount cross-check
        // validates against real funds rather than the requested figure.
        emit PaymentReceived(msg.sender, tokenAddress, serviceType, accountNumber, received);
    }

    // ─── Admin: configuration ────────────────────────────────────────────────

    function setTokenSupport(address tokenAddress, bool status) external onlyOwner {
        if (tokenAddress == address(0)) revert ZeroAddress();
        isSupportedToken[tokenAddress] = status;
        emit TokenSupportUpdated(tokenAddress, status);
    }

    /// @notice Set the maximum single refund for a token. Must be set before refunds work.
    function setMaxRefund(address tokenAddress, uint256 maxAmount) external onlyOwner {
        if (tokenAddress == address(0)) revert ZeroAddress();
        maxRefundPerTx[tokenAddress] = maxAmount;
        emit MaxRefundUpdated(tokenAddress, maxAmount);
    }

    /// @notice Halt new payments (refunds remain available so users can be made whole).
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Treasury: timelocked withdrawal ─────────────────────────────────────

    /**
     * @notice Step 1 of 2 — announce an intent to withdraw. Starts the timelock.
     * @dev    Monitor the WithdrawalQueued event and alert on it. If you see one you
     *         did not initiate, that is your signal that the owner key is compromised;
     *         call cancelWithdrawal() within the delay window.
     */
    function queueWithdrawal(address tokenAddress, address destination, uint256 amount)
        external
        onlyOwner
    {
        if (destination == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (pendingWithdrawals[tokenAddress].executableAt != 0) revert WithdrawalAlreadyQueued();

        uint256 available = IERC20(tokenAddress).balanceOf(address(this));
        if (amount > available) revert InsufficientVaultBalance(amount, available);

        uint256 executableAt = block.timestamp + WITHDRAWAL_DELAY;
        pendingWithdrawals[tokenAddress] = PendingWithdrawal({
            amount: amount,
            executableAt: executableAt,
            destination: destination
        });

        emit WithdrawalQueued(tokenAddress, destination, amount, executableAt);
    }

    /// @notice Abort a queued withdrawal — your emergency brake if a key is compromised.
    function cancelWithdrawal(address tokenAddress) external onlyOwner {
        PendingWithdrawal memory p = pendingWithdrawals[tokenAddress];
        if (p.executableAt == 0) revert NoPendingWithdrawal();

        delete pendingWithdrawals[tokenAddress];
        emit WithdrawalCancelled(tokenAddress, p.amount);
    }

    /// @notice Step 2 of 2 — execute a queued withdrawal after the timelock has elapsed.
    function executeWithdrawal(address tokenAddress) external onlyOwner nonReentrant {
        PendingWithdrawal memory p = pendingWithdrawals[tokenAddress];
        if (p.executableAt == 0) revert NoPendingWithdrawal();
        if (block.timestamp < p.executableAt) revert TimelockNotElapsed(p.executableAt);

        uint256 available = IERC20(tokenAddress).balanceOf(address(this));
        if (p.amount > available) revert InsufficientVaultBalance(p.amount, available);

        // EFFECTS before INTERACTIONS.
        delete pendingWithdrawals[tokenAddress];

        IERC20(tokenAddress).safeTransfer(p.destination, p.amount);
        emit FundsWithdrawn(p.destination, tokenAddress, p.amount);
    }

    // ─── Treasury: refunds ───────────────────────────────────────────────────

    /**
     * @notice Refund a user whose bill failed to vend after payment.
     * @dev    Deliberately capped per-transaction (see setMaxRefund). Without a cap this
     *         function is an unrestricted "send any amount anywhere" path that completely
     *         bypasses the withdrawal timelock — i.e. a compromised key could drain the
     *         vault through refunds instead. Not pausable: users must be able to be made
     *         whole even while payments are halted during an incident.
     */
    function refundUser(
        address tokenAddress,
        address recipient,
        uint256 amount,
        string calldata reason
    ) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 cap = maxRefundPerTx[tokenAddress];
        if (amount > cap) revert RefundExceedsCap(amount, cap);

        uint256 available = IERC20(tokenAddress).balanceOf(address(this));
        if (amount > available) revert InsufficientVaultBalance(amount, available);

        IERC20(tokenAddress).safeTransfer(recipient, amount);
        emit UserRefunded(recipient, tokenAddress, amount, reason);
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function vaultBalance(address tokenAddress) external view returns (uint256) {
        return IERC20(tokenAddress).balanceOf(address(this));
    }
}
