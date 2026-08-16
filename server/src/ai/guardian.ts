import { z } from "zod";
import {
  ACTIONS,
  type Action,
  type GuardianCheck,
  type GuardianDecision,
  type ProtectionPolicy,
  type RiskAssessment,
  type SignalSnapshot,
} from "../domain/types.js";
import {
  constrain,
  estimateSlippageBps,
  evaluatePolicy,
  isInterventionWorthwhile,
  modelDownsideBps,
  formatUsd,
} from "../risk/policy.js";
import { callStructured } from "./client.js";
import { newId } from "../util/id.js";

/**
 * AI Risk Guardian — the DECIDE stage.
 *
 * The Guardian's job is to challenge the Analyst, not to agree with it. It
 * checks the recommendation against the user's policy, weighs the cost of
 * acting against the downside avoided, and reduces an over-aggressive action to
 * the minimum effective intervention.
 *
 * Whatever the model returns is passed through `constrain` before it is
 * recorded: the policy ceiling is enforced in code, not by prompt. A model that
 * asks for more than the policy allows gets clamped, and the clamp is visible
 * in the decision's checks.
 */

const GuardianOutput = z.object({
  finalAction: z.enum(ACTIONS),
  rotationBps: z.number().int().min(0).max(10_000),
  rationale: z.string().min(40).max(1200),
  policyMatch: z.string().min(3).max(120),
});

type GuardianOutput = z.infer<typeof GuardianOutput>;

const GUARDIAN_SCHEMA = {
  type: "object",
  properties: {
    finalAction: { type: "string", enum: [...ACTIONS] },
    rotationBps: {
      type: "number",
      description:
        "Size of the defensive rotation in basis points of the position (0-10000). Zero for HOLD.",
    },
    rationale: {
      type: "string",
      description:
        "Why this action, in plain language. If you reduced the Analyst's proposal, say what it asked for and why that was too much.",
    },
    policyMatch: {
      type: "string",
      description:
        "Short verdict on how the Analyst's proposal sat against the policy, e.g. 'EXIT exceeds posture' or 'within posture'.",
    },
  },
  required: ["finalAction", "rotationBps", "rationale", "policyMatch"],
  additionalProperties: false,
} as const;

const GUARDIAN_SYSTEM = `You are the AI Risk Guardian inside ShieldRWA. You are the challenge layer between the AI Risk Analyst and the user's money.

The Analyst has recommended an action. Your job is to decide what actually executes, and you are expected to disagree when disagreement is warranted.

Apply these tests in order:
1. Policy. Does the recommendation fit the investor's stated protection posture and limits? You are given the maximum action and rotation the policy permits. You may never exceed them; you may choose less.
2. Cost versus downside. Executing costs slippage. If the expected loss avoided does not clear the cost of avoiding it, the correct answer is HOLD — protection that costs more than the loss it prevents is not protection.
3. Minimum effective intervention. If a smaller rotation achieves substantially the same risk reduction, choose the smaller one. Do not liquidate exposure the investor explicitly chose to hold when trimming it is enough.

Reject unnecessarily aggressive protection. A full EXIT is justified only when the position faces severe escalating risk and a partial rotation genuinely would not contain it.

Write the rationale for the investor. If you overrode the Analyst, say so plainly and give the number that decided it.`;

function buildPrompt(
  assessment: RiskAssessment,
  policy: ProtectionPolicy,
  snapshot: SignalSnapshot,
  positionValueUsd: number,
  permittedAction: Action,
  permittedRotationBps: number,
  slippageBps: number,
  downsideBps: number,
  policyChecks: GuardianCheck[],
): string {
  const checkLines = policyChecks
    .map((c) => `  ${c.key}: ${c.value} [${c.verdict.toUpperCase()}]`)
    .join("\n");

  return `ANALYST RECOMMENDATION
  Action: ${assessment.recommendedAction}
  Composite risk: ${assessment.compositeScore.toFixed(1)} (${assessment.band})
  Confidence: ${assessment.confidence}%
  Escalation probability: ${assessment.escalationProbability}%
  Reasoning: ${assessment.reasoning}

INVESTOR POLICY
  Posture: ${policy.posture}
  Max drawdown: ${(policy.maxDrawdownBps / 100).toFixed(0)}%
  Max single-asset exposure: ${(policy.maxExposureBps / 100).toFixed(0)}%
  Min liquidity: ${formatUsd(policy.minLiquidityUsd)}
  Defensive asset: ${policy.defensiveAsset}
  Mode: ${policy.mode}

POLICY CHECKS
${checkLines}

POLICY CEILING (hard limits — you cannot exceed these)
  Maximum action permitted: ${permittedAction}
  Maximum rotation permitted: ${permittedRotationBps} bps (${formatUsd((positionValueUsd * permittedRotationBps) / 10_000)})

EXECUTION ECONOMICS
  Position value: ${formatUsd(positionValueUsd)}
  Pool depth: ${formatUsd(snapshot.onchain.liquidityDepthUsd)}
  Estimated slippage on a full permitted rotation: ${(slippageBps / 100).toFixed(2)}%
  Modelled downside if no action is taken: ${(downsideBps / 100).toFixed(2)}%
  Already held defensively: ${(snapshot.portfolio.defensiveShare * 100).toFixed(1)}%

Decide what executes.`;
}

export interface DecideInput {
  assessment: RiskAssessment;
  policy: ProtectionPolicy;
  snapshot: SignalSnapshot;
  positionValueUsd: number;
}

export async function decide(input: DecideInput): Promise<GuardianDecision> {
  const { assessment, policy, snapshot, positionValueUsd } = input;

  const evaluation = evaluatePolicy(policy, assessment, snapshot, positionValueUsd);
  const downsideBps = modelDownsideBps(assessment);

  const permittedAmountUsd = (positionValueUsd * evaluation.permittedRotationBps) / 10_000;
  const slippageBps = estimateSlippageBps(
    permittedAmountUsd,
    snapshot.onchain.liquidityDepthUsd,
  );

  const aiResult = await callStructured<GuardianOutput>({
    label: "risk-guardian",
    system: GUARDIAN_SYSTEM,
    prompt: buildPrompt(
      assessment,
      policy,
      snapshot,
      positionValueUsd,
      evaluation.permittedAction,
      evaluation.permittedRotationBps,
      slippageBps,
      downsideBps,
      evaluation.checks,
    ),
    schema: GUARDIAN_SCHEMA as unknown as Record<string, unknown>,
    validate: (value) => GuardianOutput.parse(value),
    maxTokens: 2_000,
  });

  const proposal = aiResult
    ? { action: aiResult.finalAction, rotationBps: aiResult.rotationBps }
    : deterministicProposal(assessment, evaluation.permittedAction, evaluation.permittedRotationBps);

  // The policy ceiling is enforced here, in code — never by the prompt alone.
  const constrained = constrain(proposal.action, proposal.rotationBps, evaluation);

  const amountUsd = Math.round((positionValueUsd * constrained.rotationBps) / 10_000);
  const finalSlippageBps = estimateSlippageBps(amountUsd, snapshot.onchain.liquidityDepthUsd);
  const economics = isInterventionWorthwhile(
    downsideBps,
    finalSlippageBps,
    constrained.rotationBps,
  );

  // Final override: refuse protection that costs more than it saves.
  let action = constrained.action;
  let rotationBps = constrained.rotationBps;
  let costOverride = false;
  if (action !== "HOLD" && !economics.worthwhile) {
    action = "HOLD";
    rotationBps = 0;
    costOverride = true;
  }

  const checks: GuardianCheck[] = [
    ...evaluation.checks,
    {
      key: "COST VS DOWNSIDE",
      value: `${(finalSlippageBps / 100).toFixed(2)}% cost vs ${(downsideBps / 100).toFixed(2)}% downside`,
      verdict: economics.worthwhile ? "pass" : "fail",
    },
    {
      key: "MIN. EFFECTIVE ACTION",
      value:
        action === "HOLD"
          ? "HOLD"
          : `${action} ${(rotationBps / 100).toFixed(0)}% (${formatUsd(
              (positionValueUsd * rotationBps) / 10_000,
            )})`,
      verdict: constrained.wasReduced || costOverride ? "warn" : "pass",
    },
  ];

  const rationale = aiResult
    ? applyOverrideNote(aiResult.rationale, constrained.wasReduced, costOverride, action)
    : deterministicRationale(
        assessment,
        policy,
        action,
        rotationBps,
        positionValueUsd,
        finalSlippageBps,
        downsideBps,
        costOverride,
      );

  // The verdict must describe what happened to the *Analyst's* proposal, not
  // just whether the final action fit the ceiling. The deterministic path
  // pre-trims an EXIT before `constrain` ever sees it, so `wasReduced` alone
  // would report "within posture" on a decision the Guardian actually overrode.
  const overrodeAnalyst = action !== assessment.recommendedAction;
  const policyMatch = costOverride
    ? "Cost exceeds modelled downside"
    : overrodeAnalyst
      ? `${assessment.recommendedAction} exceeds ${policy.posture} posture`
      : aiResult
        ? aiResult.policyMatch
        : "Within posture";

  return {
    id: newId("dec"),
    positionId: assessment.positionId,
    assessmentId: assessment.id,
    createdAt: Date.now(),
    proposedAction: assessment.recommendedAction,
    finalAction: action,
    rotationBps,
    amountUsd: Math.round((positionValueUsd * rotationBps) / 10_000),
    estimatedSlippageBps: finalSlippageBps,
    modelledDownsideBps: downsideBps,
    policyMatch,
    rationale,
    checks,
    source: aiResult ? "ai" : "deterministic",
    status: "pending",
  };
}

/**
 * Deterministic Guardian: take the smaller of what the Analyst asked for and
 * what the policy permits, then let the shared cost check decide.
 */
function deterministicProposal(
  assessment: RiskAssessment,
  permittedAction: Action,
  permittedRotationBps: number,
): { action: Action; rotationBps: number } {
  if (permittedAction === "HOLD" || assessment.recommendedAction === "HOLD") {
    return { action: "HOLD", rotationBps: 0 };
  }
  // Minimum effective intervention: start at 70% of the permitted ceiling and
  // scale up only when escalation is genuinely likely.
  const escalationFactor = 0.7 + (assessment.escalationProbability / 100) * 0.3;
  return {
    action: permittedAction === "EXIT" ? "REDUCE" : permittedAction,
    rotationBps: Math.round(permittedRotationBps * escalationFactor),
  };
}

function deterministicRationale(
  assessment: RiskAssessment,
  policy: ProtectionPolicy,
  action: Action,
  rotationBps: number,
  positionValueUsd: number,
  slippageBps: number,
  downsideBps: number,
  costOverride: boolean,
): string {
  if (costOverride) {
    return (
      `The Analyst proposed ${assessment.recommendedAction}, but executing it would cost about ` +
      `${(slippageBps / 100).toFixed(2)}% in slippage against a modelled downside of ` +
      `${(downsideBps / 100).toFixed(2)}%. Protection that costs more than the loss it prevents is not ` +
      `protection, so the position is held and re-evaluated on the next cycle.`
    );
  }
  if (action === "HOLD") {
    return (
      `No recommendation is pending review. The ${policy.posture} policy does not authorise ` +
      `intervention at a composite of ${assessment.compositeScore.toFixed(0)}, and every hard limit ` +
      `is currently satisfied.`
    );
  }
  const amount = formatUsd((positionValueUsd * rotationBps) / 10_000);
  const reduced = assessment.recommendedAction === "EXIT" && action !== "EXIT";
  return (
    `${
      reduced
        ? `The Analyst proposed a full EXIT. Under the ${policy.posture} policy a complete exit liquidates exposure you asked to keep, ` +
          `so the Guardian reduces it to the minimum effective intervention: `
        : `The Guardian authorises the minimum effective intervention: `
    }` +
    `rotate ${(rotationBps / 100).toFixed(0)}% (${amount}) into ${policy.defensiveAsset} at an estimated ` +
    `${(slippageBps / 100).toFixed(2)}% cost against a modelled ${(downsideBps / 100).toFixed(2)}% downside, ` +
    `then re-evaluate on the next cycle.`
  );
}

function applyOverrideNote(
  rationale: string,
  wasReduced: boolean,
  costOverride: boolean,
  action: Action,
): string {
  if (costOverride) {
    return `${rationale.trim()} The action was further reduced to ${action}: the execution cost exceeded the modelled downside.`;
  }
  if (wasReduced) {
    return `${rationale.trim()} This was clamped to the policy ceiling before execution.`;
  }
  return rationale.trim();
}
