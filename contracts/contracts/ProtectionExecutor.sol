// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {RWAPosition} from "./RWAPosition.sol";
import {RiskOracle} from "./RiskOracle.sol";
import {IProtectionTypes} from "./interfaces/IProtectionTypes.sol";

/// @title ProtectionExecutor
/// @notice Executes the defensive action the AI Risk Guardian approved and
///         records the protection event with its reasoning on chain.
/// @dev The off-chain Guardian decides *what* to do; this contract enforces the
///      invariants that must hold no matter what it decides:
///        - the position's risk assessment must be fresh,
///        - the rotation may not exceed `maxRotationBps` of the position,
///        - the swap must clear the caller-supplied `minDefensiveOut`,
///        - the venue must be allowlisted.
///      Proceeds always land back in the vault; the executor never holds funds
///      between transactions.
contract ProtectionExecutor is AccessControl, ReentrancyGuard, Pausable, IProtectionTypes {
    using SafeERC20 for IERC20;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    RiskOracle public immutable riskOracle;

    /// @notice Upper bound on a single rotation, in basis points of the position.
    uint16 public maxRotationBps = 5_000;

    mapping(address router => bool) public allowedRouters;

    struct ProtectionEvent {
        address position;
        uint256 assetsIn;
        uint256 defensiveOut;
        uint16 riskBefore;
        uint16 riskAfter;
        Action action;
        uint64 timestamp;
        bytes32 reasoningHash;
    }

    ProtectionEvent[] private _events;
    mapping(address position => uint256[]) private _eventsByPosition;
    mapping(address position => uint256) public totalProtected;

    event ProtectionExecuted(
        uint256 indexed eventId,
        address indexed position,
        Action action,
        uint256 assetsIn,
        uint256 defensiveOut,
        uint16 riskBefore,
        uint16 riskAfter,
        bytes32 reasoningHash
    );
    event RouterAllowlisted(address indexed router, bool allowed);
    event MaxRotationUpdated(uint16 previous, uint16 current);

    error StaleAssessment(address position);
    error RouterNotAllowed(address router);
    error RotationTooLarge(uint256 requestedBps, uint16 maxBps);
    error SlippageExceeded(uint256 received, uint256 minimum);
    error UnsupportedAction(Action action);
    error ZeroAmount();
    error SwapFailed();

    constructor(RiskOracle riskOracle_, address admin) {
        riskOracle = riskOracle_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
    }

    struct ProtectionOrder {
        RWAPosition position;
        uint256 assetsIn;
        uint256 minDefensiveOut;
        address router;
        Action action;
        bytes32 reasoningHash;
    }

    /// @notice Perform the approved defensive rotation for a position.
    /// @return eventId Index of the recorded protection event.
    function executeProtection(ProtectionOrder calldata order)
        external
        onlyRole(GUARDIAN_ROLE)
        whenNotPaused
        nonReentrant
        returns (uint256 eventId)
    {
        if (order.assetsIn == 0) revert ZeroAmount();
        if (order.action != Action.REDUCE && order.action != Action.EXIT) {
            revert UnsupportedAction(order.action);
        }
        if (!allowedRouters[order.router]) revert RouterNotAllowed(order.router);

        address position = address(order.position);
        if (!riskOracle.isFresh(position)) revert StaleAssessment(position);
        Assessment memory before = riskOracle.latestAssessment(position);

        uint256 totalBefore = order.position.totalAssets();
        uint256 requestedBps = (order.assetsIn * 10_000) / totalBefore;
        if (requestedBps > maxRotationBps) revert RotationTooLarge(requestedBps, maxRotationBps);

        IERC20 assetToken = IERC20(order.position.asset());
        IERC20 defensiveToken = order.position.defensiveAsset();

        order.position.checkoutForProtection(order.assetsIn);

        uint256 defensiveBefore = defensiveToken.balanceOf(address(this));
        assetToken.forceApprove(order.router, order.assetsIn);
        // Router semantics are verified by balance delta, not by return value.
        IDexRouterLike(order.router).swapExactInput(
            address(assetToken),
            address(defensiveToken),
            order.assetsIn,
            order.minDefensiveOut,
            address(this)
        );
        assetToken.forceApprove(order.router, 0);

        uint256 received = defensiveToken.balanceOf(address(this)) - defensiveBefore;
        if (received < order.minDefensiveOut) revert SlippageExceeded(received, order.minDefensiveOut);

        defensiveToken.safeTransfer(position, received);
        order.position.settleProtection(order.assetsIn, received);

        // Risk after the action is anchored by the Analyst on its next cycle;
        // we record the pre-action score and let the oracle sequence carry the
        // post-action value, so the log never claims an outcome it can't prove.
        uint16 riskAfter = riskOracle.isFresh(position)
            ? riskOracle.latestAssessment(position).score
            : before.score;

        _events.push(
            ProtectionEvent({
                position: position,
                assetsIn: order.assetsIn,
                defensiveOut: received,
                riskBefore: before.score,
                riskAfter: riskAfter,
                action: order.action,
                timestamp: uint64(block.timestamp),
                reasoningHash: order.reasoningHash
            })
        );
        eventId = _events.length - 1;
        _eventsByPosition[position].push(eventId);
        totalProtected[position] += order.assetsIn;

        emit ProtectionExecuted(
            eventId,
            position,
            order.action,
            order.assetsIn,
            received,
            before.score,
            riskAfter,
            order.reasoningHash
        );
    }

    function eventCount() external view returns (uint256) {
        return _events.length;
    }

    function eventAt(uint256 id) external view returns (ProtectionEvent memory) {
        return _events[id];
    }

    function eventIdsFor(address position) external view returns (uint256[] memory) {
        return _eventsByPosition[position];
    }

    function setRouterAllowed(address router, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        allowedRouters[router] = allowed;
        emit RouterAllowlisted(router, allowed);
    }

    function setMaxRotationBps(uint16 newMax) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newMax > 0 && newMax <= 10_000, "bad bps");
        emit MaxRotationUpdated(maxRotationBps, newMax);
        maxRotationBps = newMax;
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}

interface IDexRouterLike {
    function swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external returns (uint256 amountOut);
}
