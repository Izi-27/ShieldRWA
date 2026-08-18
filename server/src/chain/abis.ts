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
  // Custom errors must be in the ABI for viem to decode a revert. Without
  // them a revert surfaces as the raw 4-byte selector rendered as text —
  // e.g. "execution reverted: * " — which says nothing.
  { type: "error", name: "StaleAssessment", inputs: [{ name: "position", type: "address" }] },
  { type: "error", name: "RouterNotAllowed", inputs: [{ name: "router", type: "address" }] },
  {
    type: "error",
    name: "RotationTooLarge",
    inputs: [
      { name: "requestedBps", type: "uint256" },
      { name: "maxBps", type: "uint16" },
    ],
  },
  {
    type: "error",
    name: "SlippageExceeded",
    inputs: [
      { name: "received", type: "uint256" },
      { name: "minimum", type: "uint256" },
    ],
  },
  { type: "error", name: "UnsupportedAction", inputs: [{ name: "action", type: "uint8" }] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "SwapFailed", inputs: [] },
  // Errors raised by the contracts the executor calls into. A revert bubbles up
  // through `executeProtection`, so viem decodes it against *this* ABI — if the
  // nested error is absent the reason is lost and you get a bare
  // "execution reverted" that names nothing.
  { type: "error", name: "NothingPending", inputs: [] },
  { type: "error", name: "EnforcedPause", inputs: [] },
  { type: "error", name: "ReentrancyGuardReentrantCall", inputs: [] },
  { type: "error", name: "SafeERC20FailedOperation", inputs: [{ name: "token", type: "address" }] },
  {
    type: "error",
    name: "AccessControlUnauthorizedAccount",
    inputs: [
      { name: "account", type: "address" },
      { name: "neededRole", type: "bytes32" },
    ],
  },
  {
    type: "error",
    name: "ERC20InsufficientBalance",
    inputs: [
      { name: "sender", type: "address" },
      { name: "balance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "ERC20InsufficientAllowance",
    inputs: [
      { name: "spender", type: "address" },
      { name: "allowance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "InsufficientLiquidity",
    inputs: [
      { name: "requested", type: "uint256" },
      { name: "available", type: "uint256" },
    ],
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
