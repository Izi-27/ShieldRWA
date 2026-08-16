// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IProtectionTypes} from "./interfaces/IProtectionTypes.sol";

/// @title RiskOracle
/// @notice Receives and anchors validated risk outputs from the off-chain AI
///         Risk Analyst so that every protective action can be audited against
///         the assessment that motivated it.
/// @dev Assessments are keyed by position vault address. Only addresses holding
///      REPORTER_ROLE may anchor; the executor reads the latest assessment to
///      enforce that it is acting on fresh data.
contract RiskOracle is AccessControl, IProtectionTypes {
    bytes32 public constant REPORTER_ROLE = keccak256("REPORTER_ROLE");

    /// @notice Maximum age of an assessment that still counts as actionable.
    uint64 public stalenessWindow;

    mapping(address position => Assessment) private _latest;
    mapping(address position => uint256) public assessmentCount;

    event AssessmentAnchored(
        address indexed position,
        uint256 indexed sequence,
        uint16 score,
        Band band,
        Action recommended,
        uint16 confidence,
        bytes32 reasoningHash
    );
    event StalenessWindowUpdated(uint64 previous, uint64 current);

    error ScoreOutOfRange(uint16 score);
    error ConfidenceOutOfRange(uint16 confidence);
    error EscalationOutOfRange(uint16 escalation);
    error NoAssessment(address position);
    error InvalidWindow();

    constructor(address admin, uint64 stalenessWindow_) {
        if (stalenessWindow_ == 0) revert InvalidWindow();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REPORTER_ROLE, admin);
        stalenessWindow = stalenessWindow_;
    }

    /// @notice Anchor a new risk assessment for a protected position.
    function anchor(
        address position,
        uint16 score,
        uint16 confidence,
        uint16 escalation,
        Action recommended,
        bytes32 reasoningHash
    ) external onlyRole(REPORTER_ROLE) returns (uint256 sequence) {
        if (score > 100) revert ScoreOutOfRange(score);
        if (confidence > 100) revert ConfidenceOutOfRange(confidence);
        if (escalation > 100) revert EscalationOutOfRange(escalation);

        _latest[position] = Assessment({
            score: score,
            confidence: confidence,
            escalation: escalation,
            recommended: recommended,
            timestamp: uint64(block.timestamp),
            reasoningHash: reasoningHash
        });

        sequence = ++assessmentCount[position];
        emit AssessmentAnchored(
            position,
            sequence,
            score,
            bandOf(score),
            recommended,
            confidence,
            reasoningHash
        );
    }

    /// @notice Latest anchored assessment for a position.
    function latestAssessment(address position) external view returns (Assessment memory) {
        Assessment memory a = _latest[position];
        if (a.timestamp == 0) revert NoAssessment(position);
        return a;
    }

    /// @notice True when a position has an assessment inside the staleness window.
    function isFresh(address position) public view returns (bool) {
        Assessment memory a = _latest[position];
        if (a.timestamp == 0) return false;
        return block.timestamp - a.timestamp <= stalenessWindow;
    }

    /// @notice Map a 0-100 score onto its risk band.
    function bandOf(uint16 score) public pure returns (Band) {
        if (score < 25) return Band.LOW;
        if (score < 50) return Band.MEDIUM;
        if (score < 75) return Band.HIGH;
        return Band.CRITICAL;
    }

    function setStalenessWindow(uint64 newWindow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newWindow == 0) revert InvalidWindow();
        emit StalenessWindowUpdated(stalenessWindow, newWindow);
        stalenessWindow = newWindow;
    }
}
