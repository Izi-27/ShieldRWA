import {
  type Action,
  type GuardianCheck,
  type Posture,
  type ProtectionPolicy,
  type RiskAssessment,
  type SignalSnapshot,
} from "../domain/types.js";

/**
 * Protection-policy evaluation.
 *
 * This is the deterministic half of the Guardian: it decides what the policy
 * *permits*, independently of what any model recommends. The AI Guardian may
 * argue for a smaller action than the policy allows, but it can never argue for
 * a larger one — `constrain` is applied to every decision before execution.
 */

/** Score at which each posture starts intervening. */
export const POSTURE_THRESHOLDS: Record<Posture, { intervene: number; exit: number }> = {
  Conservative: { intervene: 35, exit: 70 },
  Balanced: { intervene: 50, exit: 80 },
  Aggressive: { intervene: 65, exit: 90 },
};

/** Largest single rotation each posture will authorise, in basis points. */
export const POSTURE_MAX_ROTATION_BPS: Record<Posture, number> = {
  Conservative: 5_000,
  Balanced: 3_500,
  Aggressive: 2_500,
};

const ACTION_SEVERITY: Record<Action, number> = { HOLD: 0, REDUCE: 1, HEDGE: 1, EXIT: 2 };

export interface PolicyEvaluation {
  /** Strongest action the policy permits given the current assessment. */
  permittedAction: Action;
  /** Rotation size the policy authorises, in basis points of the position. */
  permittedRotationBps: number;
  /** True when the assessment breaches a hard policy limit. */
  breached: boolean;
  checks: GuardianCheck[];
  /** Human-readable summary of the policy's position. */
  summary: string;
}

/**
 * Evaluate an assessment against the user's policy.
 *
 * Returns what the policy allows — not what should happen. The Guardian
 * combines this with cost-vs-downside reasoning to pick the minimum effective
 * intervention.
 */
export function evaluatePolicy(
  policy: ProtectionPolicy,
  assessment: RiskAssessment,
  snapshot: SignalSnapshot,
  positionValueUsd: number,
): PolicyEvaluation {
  const thresholds = POSTURE_THRESHOLDS[policy.posture];
  const checks: GuardianCheck[] = [];

  // --- drawdown limit ---
  const drawdownBps = Math.round(Math.abs(snapshot.portfolio.positionDrawdownPct) * 100);
  const drawdownBreached = drawdownBps >= policy.maxDrawdownBps;
  checks.push({
    key: "MAX DRAWDOWN",
    value: `${(drawdownBps / 100).toFixed(1)}% of ${(policy.maxDrawdownBps / 100).toFixed(0)}%`,
    verdict: drawdownBreached ? "fail" : drawdownBps > policy.maxDrawdownBps * 0.6 ? "warn" : "pass",
  });

  // --- single-asset exposure limit ---
  const exposureBps = Math.round(snapshot.portfolio.concentration * 10_000);
  const exposureBreached = exposureBps > policy.maxExposureBps;
  checks.push({
    key: "MAX SINGLE ASSET",
    value: `${(exposureBps / 100).toFixed(0)}% of ${(policy.maxExposureBps / 100).toFixed(0)}%`,
    verdict: exposureBreached ? "fail" : exposureBps > policy.maxExposureBps * 0.9 ? "warn" : "pass",
  });

  // --- liquidity floor ---
  const liquidityBreached = snapshot.onchain.liquidityDepthUsd < policy.minLiquidityUsd;
  checks.push({
    key: "MIN LIQUIDITY",
    value: `${formatUsd(snapshot.onchain.liquidityDepthUsd)} of ${formatUsd(policy.minLiquidityUsd)}`,
    verdict: liquidityBreached
      ? "fail"
      : snapshot.onchain.liquidityDepthUsd < policy.minLiquidityUsd * 1.5
        ? "warn"
        : "pass",
  });

  // --- posture threshold ---
  const overIntervene = assessment.compositeScore >= thresholds.intervene;
  const overExit = assessment.compositeScore >= thresholds.exit;
  checks.push({
    key: "POSTURE THRESHOLD",
    value: `${assessment.compositeScore.toFixed(0)} of ${thresholds.intervene} (${policy.posture})`,
    verdict: overExit ? "fail" : overIntervene ? "warn" : "pass",
  });

  const breached = drawdownBreached || exposureBreached || liquidityBreached;

  let permittedAction: Action = "HOLD";
  if (overExit) permittedAction = "EXIT";
  else if (overIntervene || breached) permittedAction = "REDUCE";

  // Rotation size scales with how far past the intervention threshold we are,
  // capped by the posture's own ceiling.
  const ceiling = POSTURE_MAX_ROTATION_BPS[policy.posture];
  let permittedRotationBps = 0;
  if (permittedAction !== "HOLD") {
    const span = Math.max(1, 100 - thresholds.intervene);
    const overshoot = Math.max(0, assessment.compositeScore - thresholds.intervene) / span;
    permittedRotationBps = Math.round(Math.min(ceiling, 1_000 + overshoot * (ceiling - 1_000)));
    // A hard limit breach authorises the full posture ceiling.
    if (breached) permittedRotationBps = ceiling;
  }

  const summary = buildSummary(policy, permittedAction, permittedRotationBps, positionValueUsd);

  return { permittedAction, permittedRotationBps, breached, checks, summary };
}

/**
 * Clamp a proposed action to what the policy permits. Applied to every
 * decision, whether it came from the model or the deterministic fallback — the
 * model is never trusted to respect the ceiling on its own.
 */
export function constrain(
  proposed: Action,
  proposedRotationBps: number,
  evaluation: PolicyEvaluation,
): { action: Action; rotationBps: number; wasReduced: boolean } {
  let action = proposed;
  let wasReduced = false;

  if (ACTION_SEVERITY[proposed] > ACTION_SEVERITY[evaluation.permittedAction]) {
    action = evaluation.permittedAction;
    wasReduced = true;
  }

  let rotationBps = action === "HOLD" ? 0 : proposedRotationBps;
  if (rotationBps > evaluation.permittedRotationBps) {
    rotationBps = evaluation.permittedRotationBps;
    wasReduced = true;
  }

  // A non-HOLD action with no rotation behind it is incoherent — downgrade it.
  if (action !== "HOLD" && rotationBps <= 0) {
    action = "HOLD";
    rotationBps = 0;
    wasReduced = true;
  }

  return { action, rotationBps, wasReduced };
}

/**
 * Is intervening worth it? Compares the modelled downside avoided against the
 * cost of executing. The Guardian rejects protection that costs more than the
 * loss it prevents.
 */
export function isInterventionWorthwhile(
  modelledDownsideBps: number,
  estimatedSlippageBps: number,
  rotationBps: number,
): { worthwhile: boolean; netBenefitBps: number } {
  // Only the rotated slice pays slippage, and only it avoids the downside.
  const rotatedFraction = rotationBps / 10_000;
  const avoided = modelledDownsideBps * rotatedFraction;
  const cost = estimatedSlippageBps * rotatedFraction;
  const netBenefitBps = Math.round((avoided - cost) * 100) / 100;
  return { worthwhile: netBenefitBps > 0, netBenefitBps };
}

/**
 * Modelled downside over the horizon: how much value the position is expected
 * to lose if nothing is done, derived from the predicted trajectory.
 */
export function modelDownsideBps(assessment: RiskAssessment): number {
  const endScore = assessment.trajectory.at(-1)?.score ?? assessment.compositeScore;
  const deterioration = Math.max(0, endScore - assessment.compositeScore);
  // Empirical mapping used across the pipeline: each point of predicted score
  // deterioration corresponds to ~12bps of expected value loss, scaled by how
  // likely the escalation is.
  const likelihood = assessment.escalationProbability / 100;
  return Math.round(deterioration * 12 * likelihood);
}

/** Slippage estimate from pool depth and trade size. */
export function estimateSlippageBps(
  tradeSizeUsd: number,
  poolDepthUsd: number,
): number {
  if (poolDepthUsd <= 0) return 10_000;
  // Square-root price impact — the standard constant-product approximation.
  const ratio = tradeSizeUsd / poolDepthUsd;
  return Math.round(Math.min(10_000, Math.sqrt(ratio) * 900));
}

function buildSummary(
  policy: ProtectionPolicy,
  action: Action,
  rotationBps: number,
  positionValueUsd: number,
): string {
  if (action === "HOLD") {
    return `Under the ${policy.posture} policy no intervention is authorised at the current risk level.`;
  }
  const amount = (positionValueUsd * rotationBps) / 10_000;
  return (
    `The ${policy.posture} policy authorises up to ${(rotationBps / 100).toFixed(0)}% ` +
    `(${formatUsd(amount)}) into ${policy.defensiveAsset}, ` +
    `${policy.mode === "AUTO" ? "automatically" : "subject to your approval"}.`
  );
}

export function formatUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}
