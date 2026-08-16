// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IDexRouter} from "../interfaces/IDexRouter.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Local stand-in for the OKX DEX router, used by tests and the local
///         demo chain. Applies a configurable slippage in basis points so the
///         executor's min-out enforcement can be exercised.
contract MockDexRouter is IDexRouter {
    using SafeERC20 for IERC20;

    /// @notice Slippage applied to every swap, in basis points.
    uint16 public slippageBps;

    constructor(uint16 slippageBps_) {
        slippageBps = slippageBps_;
    }

    function setSlippageBps(uint16 newSlippage) external {
        slippageBps = newSlippage;
    }

    function swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external override returns (uint256 amountOut) {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        uint8 dIn = IERC20Metadata(tokenIn).decimals();
        uint8 dOut = IERC20Metadata(tokenOut).decimals();

        // 1:1 nominal rate, scaled for decimals, less slippage.
        uint256 scaled = amountIn;
        if (dOut > dIn) scaled = scaled * (10 ** (dOut - dIn));
        if (dOut < dIn) scaled = scaled / (10 ** (dIn - dOut));

        amountOut = (scaled * (10_000 - slippageBps)) / 10_000;
        require(amountOut >= minAmountOut, "MockDexRouter: slippage");

        MockERC20(tokenOut).mint(recipient, amountOut);
    }
}
