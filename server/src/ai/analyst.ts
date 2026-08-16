import { z } from "zod";
import { config } from "../config.js";
import {
  ACTIONS,
  type Action,
  type ClassScores,
  type RiskAssessment,
  type RiskFactor,
  type SignalSnapshot,
  bandOf,
} from "../domain/types.js";
import {
  compositeScore,
  confidenceOf,
  escalationProbability,
  projectTrajectory,
  scoreClasses,
  topFactors,
} from "../risk/scoring.js";
import { callStructured } from "./client.js";
import { newId } from "../util/id.js";

/**
 * AI Risk Analyst — the UNDERSTAND stage.
 *
 * The composite score, class scores, confidence and trajectory are computed
 * deterministically from the signals; the model never invents them. What the
 * model contributes is interpretation: which drivers matter most, what action
 * it recommends, and a plain-language explanation an investor can act on.
 *
 * That split is deliberate. A number the model made up could not be reproduced
 * from the snapshot beside it, and it is the number we anchor on chain.
 */

const AnalystOutput = z.object({
  recommendedAction: z.enum(ACTIONS),
  reasoning: z.string().min(40).max(1200),
  factors: z
    .array(
      z.object({
        label: z.string().min(3).max(80),
        weight: z.number().min(0).max(1),
      }),
    )
    .min(2)
    .max(5),
  confidenceAdjustment: z.number().min(-15).max(15).default(0),
});

type AnalystOutput = z.infer<typeof AnalystOutput>;

const ANALYST_SCHEMA = {
  type: "object",
  properties: {
    recommendedAction: { type: "string", enum: [...ACTIONS] },
    reasoning: {
      type: "string",
      description:
        "Plain-language explanation for a non-technical investor. Name the specific signals and what they imply for this position. Two to four sentences.",
    },
    factors: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "Short driver name, with its reading" },
          weight: { type: "number", description: "Share of the risk this driver explains, 0-1" },
        },
        required: ["label", "weight"],
        additionalProperties: false,
      },
    },
    confidenceAdjustment: {
      type: "number",
      description:
        "Adjustment to the computed confidence, -15 to +15, when the signals are unusually consistent or contradictory.",
    },
  },
  required: ["recommendedAction", "reasoning", "factors", "confidenceAdjustment"],
  additionalProperties: false,
} as const;

const ANALYST_SYSTEM = `You are the AI Risk Analyst inside ShieldRWA, a protection layer for tokenised real-world assets.

You are given a computed risk assessment for one position: a composite score on 0-100, per-class sub-scores, and the raw signals behind them. The scores are already calculated and are not yours to change.

Your job is interpretation:
- Recommend one action: HOLD, REDUCE, HEDGE or EXIT.
- Rank the drivers actually responsible for the score.
- Explain the situation in plain language an investor without a trading background can act on.

How to choose an action:
- HOLD when signals are inside normal ranges, or when the risk is real but not yet material.
- REDUCE when a specific, identifiable threat warrants cutting exposure.
- HEDGE when the threat is directional and offsetting is better than selling.
- EXIT only when the position faces severe, escalating risk across several signal classes at once.

Write the reasoning for a person deciding what to do with their money. Name the actual readings. Do not hedge with generic caveats, do not restate the score back as prose, and do not recommend consulting an advisor. Be specific and brief: two to four sentences.`;

function buildPrompt(
  snapshot: SignalSnapshot,
  classes: ClassScores,
  composite: number,
  confidence: number,
  escalation: number,
  positionValueUsd: number,
): string {
  return `POSITION
  Asset value: $${positionValueUsd.toLocaleString("en-US")}
  Composite risk score: ${composite.toFixed(1)} / 100 (${bandOf(composite)} band)
  Computed confidence: ${confidence}%
  Predicted escalation probability over ${config.risk.predictionHorizonHours}h: ${escalation}%

CLASS SCORES (0-100)
  Market:    ${classes.market}
  Asset:     ${classes.asset}
  On-chain:  ${classes.onchain}
  Portfolio: ${classes.portfolio}
  Predictive:${classes.predictive}

MARKET SIGNALS (${snapshot.market.source})
  Volatility:        ${snapshot.market.volatilityPct.toFixed(2)}%
  Price deviation:   ${snapshot.market.priceDeviationPct.toFixed(2)}%
  Drawdown:          ${snapshot.market.drawdownPct.toFixed(2)}%
  24h volume change: ${snapshot.market.volumeChangePct.toFixed(1)}%

ASSET / ISSUER SIGNALS
  Issuer event active: ${snapshot.asset.issuerEventActive ? "YES" : "no"}
  Event severity:      ${(snapshot.asset.issuerEventSeverity * 100).toFixed(0)}%
  Days to repayment:   ${snapshot.asset.daysToNextRepayment}
  Detail:              ${snapshot.asset.description}

ON-CHAIN SIGNALS
  Oracle deviation:  ${snapshot.onchain.oracleDeviationSigma.toFixed(2)} sigma
  Liquidity depth:   $${snapshot.onchain.liquidityDepthUsd.toLocaleString("en-US")}
  Depth change (1h): ${snapshot.onchain.depthChangePct.toFixed(1)}%
  Pool imbalance:    ${(snapshot.onchain.poolImbalance * 100).toFixed(0)}%
  Oracle staleness:  ${snapshot.onchain.oracleStalenessSeconds}s

PORTFOLIO SIGNALS
  Concentration:       ${(snapshot.portfolio.concentration * 100).toFixed(0)}%
  Correlated exposure: ${(snapshot.portfolio.correlatedExposure * 100).toFixed(0)}%
  Position drawdown:   ${snapshot.portfolio.positionDrawdownPct.toFixed(2)}%
  Already defensive:   ${(snapshot.portfolio.defensiveShare * 100).toFixed(1)}%

Interpret this assessment.`;
}

/** Deterministic action selection, used when the model is unavailable. */
export function deterministicAction(composite: number, classes: ClassScores): Action {
  if (composite >= 75) return "EXIT";
  if (composite >= 50) return "REDUCE";
  if (composite >= 35 && classes.predictive >= 60) return "REDUCE";
  return "HOLD";
}

/** Deterministic reasoning, phrased from the same readings the model sees. */
export function deterministicReasoning(
  snapshot: SignalSnapshot,
  classes: ClassScores,
  composite: number,
  factors: RiskFactor[],
): string {
  const band = bandOf(composite);
  const lead = factors[0];

  if (band === "LOW") {
    return (
      `All five signal classes are inside normal ranges, giving a composite of ${composite.toFixed(0)}. ` +
      `${lead ? `${lead.label} is the largest single driver but remains benign. ` : ""}` +
      `No intervention is warranted.`
    );
  }

  const parts: string[] = [];
  if (snapshot.asset.issuerEventActive) {
    parts.push(`the issuer has flagged ${snapshot.asset.description.toLowerCase()}`);
  }
  if (snapshot.onchain.depthChangePct < -10) {
    parts.push(
      `the primary pool has lost ${Math.abs(snapshot.onchain.depthChangePct).toFixed(0)}% of its depth`,
    );
  }
  if (snapshot.onchain.oracleDeviationSigma > 1.5) {
    parts.push(
      `price is deviating from the oracle mid by ${snapshot.onchain.oracleDeviationSigma.toFixed(1)} standard deviations`,
    );
  }
  if (snapshot.portfolio.concentration > 0.5) {
    parts.push(
      `single-asset concentration is ${(snapshot.portfolio.concentration * 100).toFixed(0)}%`,
    );
  }

  const observation =
    parts.length > 0
      ? `${capitalise(parts.join(", and "))}.`
      : `Market and on-chain readings have moved outside their normal ranges.`;

  const outlook =
    classes.predictive > composite
      ? ` Under current conditions this position is likely to deteriorate further within ${config.risk.predictionHorizonHours} hours.`
      : ` Conditions appear to be stabilising rather than deteriorating.`;

  return `${observation} That puts the composite at ${composite.toFixed(0)}, in the ${band} band.${outlook}`;
}

export interface AnalyseInput {
  snapshot: SignalSnapshot;
  previousClasses?: ClassScores;
  positionValueUsd: number;
}

/**
 * Produce a full risk assessment. Scores are always deterministic; the model
 * supplies interpretation when it is available and healthy.
 */
export async function analyse(input: AnalyseInput): Promise<RiskAssessment> {
  const { snapshot, previousClasses, positionValueUsd } = input;

  const classes = scoreClasses(snapshot, previousClasses);
  const composite = compositeScore(classes);
  const baseConfidence = confidenceOf(classes, snapshot);
  const escalation = escalationProbability(composite, classes);
  const computedFactors = topFactors(snapshot, classes);
  const trajectory = projectTrajectory(composite, classes, config.risk.predictionHorizonHours);

  const aiResult = await callStructured<AnalystOutput>({
    label: "risk-analyst",
    system: ANALYST_SYSTEM,
    prompt: buildPrompt(
      snapshot,
      classes,
      composite,
      baseConfidence,
      escalation,
      positionValueUsd,
    ),
    schema: ANALYST_SCHEMA as unknown as Record<string, unknown>,
    validate: (value) => AnalystOutput.parse(value),
    maxTokens: 2_000,
  });

  const base: Omit<RiskAssessment, "recommendedAction" | "reasoning" | "factors" | "source"> = {
    id: newId("asm"),
    positionId: snapshot.positionId,
    createdAt: snapshot.capturedAt,
    compositeScore: composite,
    band: bandOf(composite),
    confidence: baseConfidence,
    escalationProbability: escalation,
    classScores: classes,
    trajectory,
  };

  if (!aiResult) {
    return {
      ...base,
      recommendedAction: deterministicAction(composite, classes),
      reasoning: deterministicReasoning(snapshot, classes, composite, computedFactors),
      factors: computedFactors,
      source: "deterministic",
    };
  }

  // Keep the computed severities; take the model's ranking and labels. This
  // way the explanation is the model's, but every number remains reproducible.
  const factors: RiskFactor[] = aiResult.factors.map((f) => {
    const matched = computedFactors.find(
      (c) => c.label.toLowerCase().includes(f.label.toLowerCase().slice(0, 12)),
    );
    return {
      label: f.label,
      weight: Math.round(f.weight * 1000) / 1000,
      severity: matched?.severity ?? Math.round(f.weight * 100),
    };
  });

  const confidence = Math.min(
    97,
    Math.max(40, Math.round(baseConfidence + aiResult.confidenceAdjustment)),
  );

  return {
    ...base,
    confidence,
    recommendedAction: aiResult.recommendedAction,
    reasoning: aiResult.reasoning,
    factors,
    source: "ai",
  };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
