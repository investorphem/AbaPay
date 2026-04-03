// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Interface to interact with the USDT token
interface IERC20 {
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract AbaPay {
    // The "Boss" variable - This will permanently record your wallet address
    address public owner;
    IERC20 public acceptedToken;

    // The blockchain receipt generator
    event PaymentReceived(address indexed user, string serviceType, string accountNumber, uint256 amount);
    event FundsWithdrawn(address indexed boss, uint256 amount);

    constructor(address _tokenAddress) {
        // Whoever deploys this contract becomes the permanent owner
        owner = msg.sender;
        acceptedToken = IERC20(_tokenAddress);
    }

    // Security check: Only the owner can call functions with this tag
    modifier onlyOwner() {
        require(msg.sender == owner, "ACCESS DENIED: Only the CEO can do this.");
        _;
    }

    // The standard payment function for your users
    function payBill(string calldata serviceType, string calldata accountNumber, uint256 amount) external {
        require(amount > 0, "Amount must be greater than zero");
        
        // Pull the USDT from the user into this contract
        require(acceptedToken.transferFrom(msg.sender, address(this), amount), "Payment failed");

        // Broadcast the receipt to the blockchain
        emit PaymentReceived(msg.sender, serviceType, accountNumber, amount);
    }

    // 🔥 THE PREMIUM FEATURE: Withdraw all USDT profits to your personal wallet
    function withdrawFunds() external onlyOwner {
        uint256 vaultBalance = acceptedToken.balanceOf(address(this));
        require(vaultBalance > 0, "The vault is currently empty.");
        
        // Push all the funds to the owner
        require(acceptedToken.transfer(owner, vaultBalance), "Withdrawal failed");

        emit FundsWithdrawn(owner, vaultBalance);
    }
}