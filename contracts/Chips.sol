// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {ERC20} from "@openzeppelin/contracts@5.0.2/token/ERC20/ERC20.sol";

/**
 * Chips — test collateral, and nothing more
 *
 * Six decimals, so it behaves exactly like the USDC the real desk would
 * settle in and the vault's decimals offset lands where it was designed to.
 *
 * This exists because the Arc faucet gives one USDC a day. A counterparty
 * pool seeded from that is not a pool — a single trade would move it
 * completely, and every number the desk reported would be an artefact of
 * having no depth rather than a measurement of anything.
 *
 * Anyone can mint. That is the point: this token is worthless by design and
 * a permissioned faucet would only slow down testing. Do not reuse this
 * contract for anything that is supposed to hold value.
 */
contract Chips is ERC20 {
    uint256 public constant DRIP = 100_000e6; // 100,000 per faucet call

    constructor() ERC20("Chips", "CHIP") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @dev Open mint. Worthless on purpose.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Convenience for testing from a browser with no amount to type.
    function faucet() external {
        _mint(msg.sender, DRIP);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
