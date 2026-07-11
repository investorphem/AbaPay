// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * TEST-ONLY CONTRACTS. Never deploy these to a live network.
 * They exist to exercise the security properties of AbaPayV2.
 */

/// @dev Standard, well-behaved ERC20 with configurable decimals.
contract MockERC20 is ERC20 {
    uint8 private immutable _customDecimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _customDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Takes a 10% fee on every transfer. Used to prove AbaPayV2 emits the
///      ACTUALLY RECEIVED amount rather than the requested amount.
contract MockFeeToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value); // mint / burn: no fee
            return;
        }
        uint256 fee = value / 10;
        super._update(from, address(0xdead), fee);
        super._update(from, to, value - fee);
    }
}

interface IAbaPayV2 {
    function payBill(address token, string calldata serviceType, string calldata accountNumber, uint256 amount) external;
}

/// @dev A malicious token with a transfer hook that attempts to re-enter payBill.
///      Proves the nonReentrant guard actually holds.
contract ReentrantToken is ERC20 {
    IAbaPayV2 public immutable target;
    bool private attacking;

    constructor(address target_) ERC20("Evil", "EVIL") {
        target = IAbaPayV2(target_);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function attack(uint256 amount) external {
        _approve(msg.sender, address(target), type(uint256).max);
        attacking = true;
        target.payBill(address(this), "mtn", "080", amount);
    }

    // Hook fires during the vault's transferFrom and tries to re-enter.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (attacking && to == address(target)) {
            attacking = false; // only attempt once
            target.payBill(address(this), "mtn", "080", value); // should revert (ReentrancyGuard)
        }
    }
}
