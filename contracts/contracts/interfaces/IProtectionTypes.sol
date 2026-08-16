// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Shared enums and structs for the ShieldRWA protection layer.
interface IProtectionTypes {
    /// @dev Mirrors the AI Risk Analyst / Guardian action vocabulary.
    enum Action {
        HOLD,
        REDUCE,
        HEDGE,
        EXIT
    }

    /// @dev Risk band derived from the 0-100 composite score.
    enum Band {
        LOW,
        MEDIUM,
        HIGH,
        CRITICAL
    }

    /// @dev One anchored risk assessment produced off-chain by the Risk Analyst.
    struct Assessment {
        uint16 score;          // composite risk score, 0-100
        uint16 confidence;     // model confidence, 0-100
        uint16 escalation;     // predicted probability of escalation, 0-100
        Action recommended;    // Analyst recommendation
        uint64 timestamp;      // block timestamp at anchoring
        bytes32 reasoningHash; // keccak256 of the plain-language reasoning payload
    }
}
