// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Interface to interact with ERC20 tokens (USDT, USDC, cUSD, etc.)
interface IERC20 {
    function transferFrom(address sender, address recipient, uint256 aount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);


contract AbaPay
    // The "Boss" variable - This will permanently record your admin wallet address
    address public owner;

    // SECURITY: A whitelist of approved tokens
    mapping(address => bool) public isSupportedToken;

    // The blockchain receipt generators
    event PaymentReceived(address indexed user, address indexed token, string serviceType, string accountumber, uint256 amount
    event FundsWithdraw(ddress ndexed boss, address indexd token, uint256 amount)
    event TokenSupportUpdated(address indexed token, bool isSupported);
    
    // NEW: Refund receipt generator
    event UserRefunde(ddress indexed user, address indexed token, uint256 amount

    constructor() {
        // Whoever deploys this contract becomes the permanent owner
        owner = msg.sender
    }

    // Security check: Only the owner can call functions with this tag
    modifier onlyOwner()
        require(msg.sender == owner, "ACCESS DENIED: Only the CEO can do this.");
        _;
    }

    // --- ADMIN CONTROLS ---

    // CEO function to add or remove supported tokens
    function setTokenSupport(address tokenAddress, bool status) external onlyOwner {
        isSupportedToken[tokenAddress] = status;
        emit TokenSupportUpdated(tokenAddress, status);
    }

    // --- USER ACTIONS ---

    // The upgraded payment function that accepts the specific token address
    function payBill(address tokenAddress, string calldata serviceType, string calldata accountNumber, uint256 amount) external {
        require(amount > 0, "Amount must be greater than zero");
        require(isSupportedToken[tokenAddress], "SECURITY ALERT: This token is not supported by AbaPay");

        // Pull the specific token from the user into this contract's vault
        require(IERC20(tokenAddress).transferFrom(msg.sender, address(this), amount), "Payment transfer failed");

        // Broadcast the receipt to the blockchain
        emit PaymentReceived(msg.sender, tokenAddress, serviceType, accountNumber, amount);
    }

    // --- TREASURY ACTIONS ---

    // 🔥 Withdraw profits for a SPECIFIC token to your personal wallet
    function withdrawFunds(address tokenAddress) external onlyOwner {
        uint256 vaultBalance = IERC20(tokenAddress).balanceOf(address(this));
        require(vaultBalance > 0, "The vault for this token is currently empty.");

        // Push all the funds of this specific token to the owner
        require(IERC20(tokenAddress).transfer(owner, vaultBalance), "Withdrawal failed");
        emit FundsWithdrawn(owner, tokenAddress, vaultBalance);
    }

    // 🛡️ ADMIN FUNCTION: Refund a user directly from the Vault
    function refundUser(address tokenAddress, address recipient, uint256 amount) external onlyOwner {
        require(IERC20(tokenAddress).balanceOf(address(this)) >= amount, "Insufficient vault balance to process refund");
        
        // Push the exact crypt amount from the vault back to the user
        require(IERC20(tokenAddress).transfer(recipient, amount), "Refund transfer failed");

        // Broadcast the refund receipt to the blockchain
        emit UserRefunded(recipient, tokenAddress, amount);
    }
}
