/** Core domain vocabulary shared by the risk pipeline, AI layer and API. */

export const ACTIONS = ["HOLD", "REDUCE", "HEDGE", "EXIT"] as const;
export type Action = (typeof ACTIONS)[number];

export const BANDS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type Band = (typeof BANDS)[number];

export const POSTURES = ["Conservative", "Balanced", "Aggressive"] as const;
export type Posture = (typeof POSTURES)[number];

export type ProtectionMode = "AUTO" | "MANUAL";

/** On-chain action encoding must match `IProtectionTypes.Action`. */
export const ACTION_ENUM: Record<Action, number> = {
  HOLD: 0,
  REDUCE: 1,
  HEDGE: 2,
  EXIT: 3,
};

export interface MarketSignals {
  /** Annualised realised volatility, percent. */
  volatilityPct: number;
  /** Absolute deviation of spot from the reference price, percent. */
  priceDeviationPct: number;
  /** Drawdown from the trailing high, percent. */
  drawdownPct: number;
  /** 24h volume change, percent. */
  volumeChangePct: number;
  /** Spot price used for the above, in USD. */
  priceUsd: number;
  /** Where the numbers came from — surfaced to the user, never hidden. */
  source: "live" | "simulated";
}

export interface AssetSignals {
  /** True when the issuer has reported a repayment or maturity problem. */
  issuerEventActive: boolean;
  /** Severity of the issuer event, 0-1. */
  issuerEventSeverity: number;
  /** Days until the next scheduled repayment. */
  daysToNextRepayment: number;
  description: string;
}

export interface OnchainSignals {
  /** Deviation between pool mid and oracle mid, in standard deviations. */
  oracleDeviationSigma: number;
  /** Total pool depth in USD. */
  liquidityDepthUsd: number;
  /** Change in depth over the last hour, percent (negative = thinning). */
  depthChangePct: number;
  /** Pool imbalance, 0 (balanced) to 1 (fully one-sided). */
  poolImbalance: number;
  /** Seconds since the last oracle heartbeat. */
  oracleStalenessSeconds: number;
}

export interface PortfolioSignals {
  /** Largest single-asset weight, as a fraction of the portfolio. */
  concentration: number;
  /** Correlated exposure across issuers, 0-1. */
  correlatedExposure: number;
  /** Position drawdown since registration, percent. */
  positionDrawdownPct: number;
  /** Liquid (defensive) share of the position, as a fraction. */
  defensiveShare: number;
}

export interface SignalSnapshot {
  positionId: string;
  capturedAt: number;
  market: MarketSignals;
  asset: AssetSignals;
  onchain: OnchainSignals;
  portfolio: PortfolioSignals;
}

/** Per-class sub-scores on the same 0-100 scale as the composite. */
export interface ClassScores {
  market: number;
  asset: number;
  onchain: number;
  portfolio: number;
  predictive: number;
}

export interface RiskFactor {
  label: string;
  /** Share of the composite score this factor explains, 0-1. */
  weight: number;
  /** The factor's own severity, 0-100. */
  severity: number;
}

export interface TrajectoryPoint {
  /** Hours from now. */
  hour: number;
  score: number;
}

export interface RiskAssessment {
  id: string;
  positionId: string;
  createdAt: number;
  compositeScore: number;
  band: Band;
  confidence: number;
  escalationProbability: number;
  recommendedAction: Action;
  classScores: ClassScores;
  factors: RiskFactor[];
  trajectory: TrajectoryPoint[];
  reasoning: string;
  source: "ai" | "deterministic";
  anchorTxHash?: string | null;
  anchoredAt?: number | null;
}

export interface ProtectionPolicy {
  positionId: string;
  posture: Posture;
  maxDrawdownBps: number;
  maxExposureBps: number;
  minLiquidityUsd: number;
  defensiveAsset: string;
  mode: ProtectionMode;
  updatedAt: number;
}

export interface GuardianCheck {
  key: string;
  value: string;
  verdict: "pass" | "warn" | "fail" | "n/a";
}

export interface GuardianDecision {
  id: string;
  positionId: string;
  assessmentId: string;
  createdAt: number;
  proposedAction: Action;
  finalAction: Action;
  rotationBps: number;
  amountUsd: number;
  estimatedSlippageBps: number;
  modelledDownsideBps: number;
  policyMatch: string;
  rationale: string;
  checks: GuardianCheck[];
  source: "ai" | "deterministic";
  status: "pending" | "approved" | "rejected" | "executed" | "failed" | "superseded";
  resolvedAt?: number | null;
}

export interface ProtectionEvent {
  id: string;
  positionId: string;
  decisionId?: string | null;
  createdAt: number;
  action: Action;
  amountUsd: number;
  riskBefore: number;
  riskAfter?: number | null;
  txHash?: string | null;
  chainEventId?: number | null;
  status: "submitted" | "confirmed" | "failed" | "simulated";
  reasoning: string;
  error?: string | null;
}

export interface Position {
  id: string;
  ownerAddress: string;
  vaultAddress?: string | null;
  assetSymbol: string;
  assetName: string;
  valueUsd: number;
  shares: string;
  status: "pending" | "active" | "closed";
  createdAt: number;
  updatedAt: number;
}

export interface ActivityEntry {
  id: number;
  positionId?: string | null;
  createdAt: number;
  severity: "info" | "warning" | "critical" | "success";
  stage: "DETECT" | "UNDERSTAND" | "DECIDE" | "PROTECT" | "SYSTEM";
  message: string;
}

export interface InjectedEvent {
  id: string;
  positionId: string;
  kind: "issuer" | "liquidity" | "oracle";
  severity: number;
  createdAt: number;
  expiresAt: number;
  description: string;
}

/**
 * Single-asset concentration a freshly registered position starts at.
 *
 * A single-asset vault is concentrated by construction — that is the exposure
 * ShieldRWA exists to watch, not a fault to be alarmed about on day one.
 */
export const BASELINE_CONCENTRATION = 0.61;

/**
 * Default single-asset exposure cap for a position at the given concentration.
 *
 * A policy must not be breached the moment it is created. A cap below the
 * position's own starting concentration puts the Guardian permanently in
 * "limit breached" mode, which makes the breach signal meaningless — an alarm
 * that is always on tells the investor nothing, and it drives a protective
 * evaluation on every cycle for a condition the user never opted into.
 *
 * So the default sits just above where the position actually starts, rounded
 * up to a clean 5%. Tightening it below current concentration is then a
 * deliberate choice, and the resulting breach is real information.
 */
export function defaultExposureCapBps(concentration = BASELINE_CONCENTRATION): number {
  const currentBps = Math.round(concentration * 10_000);
  const roundedUp = Math.ceil((currentBps + 1) / 500) * 500;
  // Never below the 40% floor a diversified portfolio would want, never above
  // the 90% ceiling the policy schema permits.
  return Math.min(9_000, Math.max(4_000, roundedUp));
}

export function bandOf(score: number): Band {
  if (score < 25) return "LOW";
  if (score < 50) return "MEDIUM";
  if (score < 75) return "HIGH";
  return "CRITICAL";
}

export function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}
