// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal surface the executor needs from a swap venue.
/// @dev Production routing goes through the OKX DEX aggregator, which returns
///      pre-built calldata for its router. The executor therefore calls an
///      allowlisted router with opaque calldata and verifies the outcome by
///      balance delta rather than trusting a return value. This interface is
///      the shape the local mock implements for tests.
interface IDexRouter {
    function swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external returns (uint256 amountOut);
}
