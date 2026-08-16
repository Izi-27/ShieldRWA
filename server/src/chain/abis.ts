/**
 * Minimal ABIs for the deployed protection layer. Hand-written rather than
 * imported from build artifacts so the server has no build-order dependency on
 * the contracts package; each entry mirrors the Solidity signature exactly.
 */

export const riskOracleAbi = [
  {
    type: "function",
    name: "anchor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "position", type: "address" },
      { name: "score", type: "uint16" },
      { name: "confidence", type: "uint16" },
      { name: "escalation", type: "uint16" },
      { name: "recommended", type: "uint8" },
      { name: "reasoningHash", type: "bytes32" },
    ],
    outputs: [{ name: "sequence", type: "uint256" }],
  },
  {
    type: "function",
    name: "latestAssessment",
    stateMutability: "view",
    inputs: [{ name: "position", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "score", type: "uint16" },
          { name: "confidence", type: "uint16" },
          { name: "escalation", type: "uint16" },
          { name: "recommended", type: "uint8" },
          { name: "timestamp", type: "uint64" },
          { name: "reasoningHash", type: "bytes32" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "isFresh",
    stateMutability: "view",
    inputs: [{ name: "position", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "stalenessWindow",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
] as const;

export const rwaPositionAbi = [
  {
    type: "function",
    name: "totalAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "defensiveShareBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "defensiveInAssetUnits",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "asset",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "defensiveAsset",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "convertToAssets",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const protectionExecutorAbi = [
  {
    type: "function",
    name: "executeProtection",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "position", type: "address" },
          { name: "assetsIn", type: "uint256" },
          { name: "minDefensiveOut", type: "uint256" },
          { name: "router", type: "address" },
          { name: "action", type: "uint8" },
          { name: "reasoningHash", type: "bytes32" },
        ],
      },
    ],
    outputs: [{ name: "eventId", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalProtected",
    stateMutability: "view",
    inputs: [{ name: "position", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "eventCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "maxRotationBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint16" }],
  },
  {
    type: "event",
    name: "ProtectionExecuted",
    inputs: [
      { name: "eventId", type: "uint256", indexed: true },
      { name: "position", type: "address", indexed: true },
      { name: "action", type: "uint8", indexed: false },
      { name: "assetsIn", type: "uint256", indexed: false },
      { name: "defensiveOut", type: "uint256", indexed: false },
      { name: "riskBefore", type: "uint16", indexed: false },
      { name: "riskAfter", type: "uint16", indexed: false },
      { name: "reasoningHash", type: "bytes32", indexed: false },
    ],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
