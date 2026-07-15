// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AbaPayV3
 * @notice AbaPayV2 + on-chain spending allowances, enabling agent-initiated bill payments
 *         WITHOUT AbaPay ever custodying user funds.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ⚠️  NOT AUDITED. This contract lets an authorised relayer move user funds (bounded).
 *      Deploy to TESTNET for demos. On mainnet, use SMALL caps only, until audited.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE PROBLEM
 * -----------
 * V1/V2's payBill() uses transferFrom(msg.sender, ...), so the PAYER MUST BE THE CALLER.
 * On Telegram/WhatsApp there is no wallet to sign with, so the agent could never actually
 * pay — it could only hand the user a deep link to sign in the app.
 *
 * THE SOLUTION (and why it is NOT custody)
 * ----------------------------------------
 * The user, FROM THEIR OWN WALLET, does two things once:
 *   1. ERC-20 approve(AbaPayV3, X)        — standard token approval
 *   2. setSpendingAllowance(token, X)     — an on-chain cap they control
 *
 * After that, an authorised relayer may call payBillFor() on their behalf — but the
 * CONTRACT ITSELF checks and decrements the remaining allowance on every call. The cap is
 * enforced by the blockchain, not by our backend.
 *
 * SECURITY MODEL — read this carefully:
 *   • AbaPay NEVER holds user keys or user funds. Tokens move directly from the user's
 *     wallet into this vault at payment time.
 *   • The relayer is a HOT KEY. If it is stolen, the attacker can spend AT MOST each
 *     user's remaining allowance, and ONLY through payBillFor. They cannot drain a user's
 *     wallet, cannot raise anyone's allowance, and cannot withdraw the vault.
 *   • Users can revoke instantly and unilaterally: setSpendingAllowance(token, 0).
 *   • The owner can disable the relayer entirely (setRelayer(address(0))) or pause().
 *   • Per-transaction and per-user caps bound blast radius further.
 *
 * This is the standard session-key / delegated-spend pattern. The user's exposure is
 * exactly the number they chose, and it is provable on-chain.
 */
contract AbaPayV3 is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Config ──────────────────────────────────────────────────────────────

    uint256 public constant WITHDRAWAL_DELAY = 24 hours;

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

    /// @dev IDENTICAL signature to V1/V2 — the existing webhook decodes this unchanged.
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

    // ─── USER: direct payment (unchanged from V2) ────────────────────────────

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

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Treasury (timelocked, as V2) ────────────────────────────────────────

    function queueWithdrawal(address tokenAddress, address destination, uint256 amount) external onlyOwner {
        if (destination == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (pendingWithdrawals[tokenAddress].executableAt != 0) revert WithdrawalAlreadyQueued();

        uint256 available = IERC20(tokenAddress).balanceOf(address(this));
        if (amount > available) revert InsufficientVaultBalance(amount, available);

        uint256 executableAt = block.timestamp + WITHDRAWAL_DELAY;
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
