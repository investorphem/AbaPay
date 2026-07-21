// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AbaPayV4
 * @notice AbaPayV3, with exactly ONE functional difference: the treasury withdrawal
 *         timelock is an OWNER-SETTABLE DURATION instead of a fixed 24h constant.
 *         Every other function, event, error and access rule is identical to V3.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ⚠️  NOT AUDITED. Same relayer/allowance blast-radius notes as V3 apply.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS
 * ----------------
 * V3 hardcodes a 24h withdrawal timelock as protection against a compromised owner key
 * unilaterally draining the vault. That is the RIGHT default. But it also means a
 * legitimate emergency (e.g. suspected exploit elsewhere, needing funds moved to safety
 * FAST) is stuck behind the same 24h wall as routine operations.
 *
 * V4 keeps the exact same queue -> wait -> execute mechanics, but the wait duration
 * (`withdrawalDelay`) is now a variable the owner can raise, lower, or set to zero via
 * setWithdrawalDelay(). Defaults to 24h, same as V3 — nothing changes unless the owner
 * deliberately changes it.
 *
 * ⚠️  TRADE-OFF, READ THIS: lowering withdrawalDelay (especially to 0) weakens the exact
 *     protection the timelock exists for. A compromised owner key can then queue AND
 *     execute a withdrawal back-to-back with no cooling-off window for anyone to notice
 *     and react (e.g. via setRelayer(0) or pause()). Use a low delay only when you
 *     specifically need same-day emergency access, and prefer raising it back to a real
 *     delay (e.g. 24h) once the emergency has passed.
 *
 * Changing the delay does NOT retroactively affect an already-queued withdrawal — its
 * executableAt was fixed at queue time. Only withdrawals queued AFTER the change use the
 * new duration.
 */
contract AbaPayV4 is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Config ──────────────────────────────────────────────────────────────

    /// @notice How long a queued withdrawal must wait before it can execute. Defaults to
    ///         24h (same as V3's fixed constant) — owner-adjustable via setWithdrawalDelay.
    ///         See the contract-level NatSpec above for the security trade-off of lowering it.
    uint256 public withdrawalDelay = 24 hours;

    /// @notice The backend agent permitted to call payBillFor. Set to address(0) to disable.
    address public relayer;

    /// @notice Hard ceiling on a single agent-initiated payment, per token.
    ///         A second bound on top of the user's own allowance.
    mapping(address => uint256) public maxAgentPaymentPerTx;

    /// @notice user => token => remaining amount the agent may spend on their behalf.
    mapping(address => mapping(address => uint256)) public spendingAllowance;

    mapping(address => uint256) public maxRefundPerTx;
    mapping(address => bool) public isSupportedToken;

    struct PendingWithdrawal { uint256 amount; uint256 executableAt; address destination; }
    mapping(address => PendingWithdrawal) public pendingWithdrawals;

    // ─── Events ──────────────────────────────────────────────────────────────

    /// @dev IDENTICAL signature to V1/V2/V3 — the existing webhook decodes this unchanged.
    event PaymentReceived(
        address indexed user,
        address indexed token,
        string serviceType,
        string accountNumber,
        uint256 amount
    );

    /// @dev Emitted additionally when the payment was agent-initiated, so the backend and
    ///      any observer can distinguish "the user signed" from "the agent spent an allowance".
    event AgentPayment(address indexed user, address indexed token, uint256 amount, uint256 remainingAllowance);

    event SpendingAllowanceSet(address indexed user, address indexed token, uint256 amount);
    event RelayerUpdated(address indexed relayer);
    event MaxAgentPaymentUpdated(address indexed token, uint256 maxAmount);

    event TokenSupportUpdated(address indexed token, bool isSupported);
    event MaxRefundUpdated(address indexed token, uint256 maxAmount);
    event WithdrawalQueued(address indexed token, address indexed destination, uint256 amount, uint256 executableAt);
    event WithdrawalCancelled(address indexed token, uint256 amount);
    event FundsWithdrawn(address indexed destination, address indexed token, uint256 amount);
    event UserRefunded(address indexed user, address indexed token, uint256 amount, string reason);

    /// @dev NEW vs V3 — the only structural addition.
    event WithdrawalDelayUpdated(uint256 previousDelay, uint256 newDelay);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAmount();
    error ZeroAddress();
    error TokenNotSupported(address token);
    error InsufficientVaultBalance(uint256 requested, uint256 available);
    error NoPendingWithdrawal();
    error TimelockNotElapsed(uint256 executableAt);
    error WithdrawalAlreadyQueued();
    error RefundExceedsCap(uint256 requested, uint256 cap);

    error NotRelayer();
    error RelayerDisabled();
    error ExceedsSpendingAllowance(uint256 requested, uint256 remaining);
    error ExceedsMaxAgentPayment(uint256 requested, uint256 cap);

    // ─────────────────────────────────────────────────────────────────────────

    constructor(address initialOwner) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
    }

    modifier onlyRelayer() {
        if (relayer == address(0)) revert RelayerDisabled();
        if (msg.sender != relayer) revert NotRelayer();
        _;
    }

    // ─── USER: direct payment (unchanged from V2/V3) ─────────────────────────

    function payBill(
        address tokenAddress,
        string calldata serviceType,
        string calldata accountNumber,
        uint256 amount
    ) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (!isSupportedToken[tokenAddress]) revert TokenNotSupported(tokenAddress);

        uint256 received = _pull(tokenAddress, msg.sender, amount);
        emit PaymentReceived(msg.sender, tokenAddress, serviceType, accountNumber, received);
    }

    // ─── USER: allowance control (the consent step) ──────────────────────────

    /**
     * @notice Authorise the AbaPay agent to spend up to `amount` of `tokenAddress` on your
     *         bills. Call with 0 to revoke instantly.
     * @dev    The user must ALSO ERC-20 approve() this contract for at least `amount`.
     *         Both are required: the ERC-20 approval lets us move the tokens at all, and
     *         this allowance is the cap the agent is bound by.
     *
     *         ONLY the user can set their own allowance. There is deliberately no
     *         owner/relayer function to raise someone's allowance — so a compromised
     *         backend cannot grant itself more room.
     */
    function setSpendingAllowance(address tokenAddress, uint256 amount) external {
        if (!isSupportedToken[tokenAddress]) revert TokenNotSupported(tokenAddress);
        spendingAllowance[msg.sender][tokenAddress] = amount;
        emit SpendingAllowanceSet(msg.sender, tokenAddress, amount);
    }

    function remainingAllowance(address user, address tokenAddress) external view returns (uint256) {
        return spendingAllowance[user][tokenAddress];
    }

    // ─── AGENT: bounded, delegated payment ───────────────────────────────────

    /**
     * @notice Pay a bill on a user's behalf, bounded by THEIR on-chain allowance.
     * @dev    Callable only by the authorised relayer, only while unpaused.
     *
     *         Every constraint here is enforced ON-CHAIN, not by our backend:
     *           • the user must have set an allowance (defaults to 0 = agent can do nothing)
     *           • the amount must fit within their remaining allowance
     *           • the amount must fit within the per-tx ceiling for that token
     *           • the allowance is decremented BEFORE any token movement (checks-effects-interactions)
     */
    function payBillFor(
        address user,
        address tokenAddress,
        string calldata serviceType,
        string calldata accountNumber,
        uint256 amount
    ) external onlyRelayer whenNotPaused nonReentrant {
        if (user == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!isSupportedToken[tokenAddress]) revert TokenNotSupported(tokenAddress);

        uint256 perTxCap = maxAgentPaymentPerTx[tokenAddress];
        if (amount > perTxCap) revert ExceedsMaxAgentPayment(amount, perTxCap);

        uint256 remaining = spendingAllowance[user][tokenAddress];
        if (amount > remaining) revert ExceedsSpendingAllowance(amount, remaining);

        // EFFECTS BEFORE INTERACTIONS: burn the allowance first, so a reentrant token
        // cannot spend the same allowance twice.
        unchecked { spendingAllowance[user][tokenAddress] = remaining - amount; }

        uint256 received = _pull(tokenAddress, user, amount);

        // Same event the webhook already validates against — the backend needs no changes.
        emit PaymentReceived(user, tokenAddress, serviceType, accountNumber, received);
        emit AgentPayment(user, tokenAddress, received, spendingAllowance[user][tokenAddress]);
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    /// @dev Pulls tokens and returns the amount ACTUALLY received (fee-on-transfer safe).
    function _pull(address tokenAddress, address from, uint256 amount) private returns (uint256) {
        uint256 before = IERC20(tokenAddress).balanceOf(address(this));
        IERC20(tokenAddress).safeTransferFrom(from, address(this), amount);
        uint256 received = IERC20(tokenAddress).balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
        return received;
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    /// @notice Authorise (or disable, with address(0)) the agent relayer.
    function setRelayer(address newRelayer) external onlyOwner {
        relayer = newRelayer;
        emit RelayerUpdated(newRelayer);
    }

    /// @notice Ceiling on any single agent-initiated payment. Agent payments revert until set.
    function setMaxAgentPayment(address tokenAddress, uint256 maxAmount) external onlyOwner {
        if (tokenAddress == address(0)) revert ZeroAddress();
        maxAgentPaymentPerTx[tokenAddress] = maxAmount;
        emit MaxAgentPaymentUpdated(tokenAddress, maxAmount);
    }

    function setTokenSupport(address tokenAddress, bool status) external onlyOwner {
        if (tokenAddress == address(0)) revert ZeroAddress();
        isSupportedToken[tokenAddress] = status;
        emit TokenSupportUpdated(tokenAddress, status);
    }

    function setMaxRefund(address tokenAddress, uint256 maxAmount) external onlyOwner {
        if (tokenAddress == address(0)) revert ZeroAddress();
        maxRefundPerTx[tokenAddress] = maxAmount;
        emit MaxRefundUpdated(tokenAddress, maxAmount);
    }

    /// @notice Change the queue->execute waiting period for FUTURE withdrawals. Set to 0 for
    ///         instant (queue and execute in the same block/back-to-back txs) — an emergency
    ///         escape valve. Raise it back to a real delay (e.g. 24 hours) once the emergency
    ///         has passed; see the contract-level NatSpec for why that matters. Does NOT touch
    ///         an already-queued withdrawal's executableAt.
    function setWithdrawalDelay(uint256 newDelay) external onlyOwner {
        uint256 previous = withdrawalDelay;
        withdrawalDelay = newDelay;
        emit WithdrawalDelayUpdated(previous, newDelay);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Treasury (timelocked, duration owner-adjustable — see withdrawalDelay) ─────

    function queueWithdrawal(address tokenAddress, address destination, uint256 amount) external onlyOwner {
        if (destination == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (pendingWithdrawals[tokenAddress].executableAt != 0) revert WithdrawalAlreadyQueued();

        uint256 available = IERC20(tokenAddress).balanceOf(address(this));
        if (amount > available) revert InsufficientVaultBalance(amount, available);

        uint256 executableAt = block.timestamp + withdrawalDelay;
        pendingWithdrawals[tokenAddress] = PendingWithdrawal(amount, executableAt, destination);
        emit WithdrawalQueued(tokenAddress, destination, amount, executableAt);
    }

    function cancelWithdrawal(address tokenAddress) external onlyOwner {
        PendingWithdrawal memory p = pendingWithdrawals[tokenAddress];
        if (p.executableAt == 0) revert NoPendingWithdrawal();
        delete pendingWithdrawals[tokenAddress];
        emit WithdrawalCancelled(tokenAddress, p.amount);
    }

    function executeWithdrawal(address tokenAddress) external onlyOwner nonReentrant {
        PendingWithdrawal memory p = pendingWithdrawals[tokenAddress];
        if (p.executableAt == 0) revert NoPendingWithdrawal();
        if (block.timestamp < p.executableAt) revert TimelockNotElapsed(p.executableAt);

        uint256 available = IERC20(tokenAddress).balanceOf(address(this));
        if (p.amount > available) revert InsufficientVaultBalance(p.amount, available);

        delete pendingWithdrawals[tokenAddress];
        IERC20(tokenAddress).safeTransfer(p.destination, p.amount);
        emit FundsWithdrawn(p.destination, tokenAddress, p.amount);
    }

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

    function vaultBalance(address tokenAddress) external view returns (uint256) {
        return IERC20(tokenAddress).balanceOf(address(this));
    }
}
