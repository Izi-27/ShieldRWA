import { describe, expect, it } from "vitest";
import type { ProtectionPolicy, RiskAssessment, SignalSnapshot } from "../domain/types.js";
import { BASELINE_CONCENTRATION, defaultExposureCapBps } from "../domain/types.js";
import {
  POSTURE_MAX_ROTATION_BPS,
  POSTURE_THRESHOLDS,
  constrain,
  estimateSlippageBps,
  evaluatePolicy,
  isInterventionWorthwhile,
  modelDownsideBps,
} from "./policy.js";

const balanced: ProtectionPolicy = {
  positionId: "pos_1",
  posture: "Balanced",
  maxDrawdownBps: 1_000, // 10%
  maxExposureBps: 4_000, // 40%
  minLiquidityUsd: 250_000,
  defensiveAsset: "USDC",
  mode: "AUTO",
  updatedAt: Date.now(),
};

const healthySnapshot: SignalSnapshot = {
  positionId: "pos_1",
  capturedAt: Date.now(),
  market: {
    volatilityPct: 1.2,
    priceDeviationPct: 0.2,
    drawdownPct: 0.2,
    volumeChangePct: 5,
    priceUsd: 1,
    source: "live",
  },
  asset: {
    issuerEventActive: false,
    issuerEventSeverity: 0,
    daysToNextRepayment: 40,
    description: "nominal",
  },
  onchain: {
    oracleDeviationSigma: 0.2,
    liquidityDepthUsd: 2_400_000,
    depthChangePct: 1,
    poolImbalance: 0.07,
    oracleStalenessSeconds: 20,
  },
  portfolio: {
    concentration: 0.3,
    correlatedExposure: 0.2,
    positionDrawdownPct: 0.2,
    defensiveShare: 0,
  },
};

function assessment(score: number, escalation = 60, endScore = score + 20): RiskAssessment {
  return {
    id: "asm_1",
    positionId: "pos_1",
    createdAt: Date.now(),
    compositeScore: score,
    band: score < 25 ? "LOW" : score < 50 ? "MEDIUM" : score < 75 ? "HIGH" : "CRITICAL",
    confidence: 85,
    escalationProbability: escalation,
    recommendedAction: "HOLD",
    classScores: { market: score, asset: score, onchain: score, portfolio: score, predictive: score },
    factors: [],
    trajectory: [
      { hour: 0, score },
      { hour: 6, score: endScore },
    ],
    reasoning: "test",
    source: "deterministic",
  };
}

describe("evaluatePolicy", () => {
  it("permits nothing while the position is healthy and below the posture threshold", () => {
    const result = evaluatePolicy(balanced, assessment(20), healthySnapshot, 10_000);
    expect(result.permittedAction).toBe("HOLD");
    expect(result.permittedRotationBps).toBe(0);
    expect(result.breached).toBe(false);
    expect(result.checks.every((c) => c.verdict === "pass")).toBe(true);
  });

  it("permits a REDUCE once the score passes the posture's intervention threshold", () => {
    const result = evaluatePolicy(balanced, assessment(60), healthySnapshot, 10_000);
    expect(result.permittedAction).toBe("REDUCE");
    expect(result.permittedRotationBps).toBeGreaterThan(0);
    expect(result.permittedRotationBps).toBeLessThanOrEqual(POSTURE_MAX_ROTATION_BPS.Balanced);
  });

  it("permits an EXIT only past the posture's exit threshold", () => {
    expect(evaluatePolicy(balanced, assessment(79), healthySnapshot, 10_000).permittedAction).toBe(
      "REDUCE",
    );
    expect(evaluatePolicy(balanced, assessment(85), healthySnapshot, 10_000).permittedAction).toBe(
      "EXIT",
    );
  });

  it("intervenes earlier under a Conservative posture than an Aggressive one", () => {
    const conservative = { ...balanced, posture: "Conservative" as const };
    const aggressive = { ...balanced, posture: "Aggressive" as const };
    const score = assessment(40);

    expect(evaluatePolicy(conservative, score, healthySnapshot, 10_000).permittedAction).toBe(
      "REDUCE",
    );
    expect(evaluatePolicy(aggressive, score, healthySnapshot, 10_000).permittedAction).toBe("HOLD");
    expect(POSTURE_THRESHOLDS.Conservative.intervene).toBeLessThan(
      POSTURE_THRESHOLDS.Aggressive.intervene,
    );
  });

  it("flags a liquidity breach and authorises the full posture ceiling", () => {
    const thin = {
      ...healthySnapshot,
      onchain: { ...healthySnapshot.onchain, liquidityDepthUsd: 120_000 },
    };
    const result = evaluatePolicy(balanced, assessment(30), thin, 10_000);
    expect(result.breached).toBe(true);
    expect(result.permittedAction).toBe("REDUCE");
    expect(result.permittedRotationBps).toBe(POSTURE_MAX_ROTATION_BPS.Balanced);
    expect(result.checks.find((c) => c.key === "MIN LIQUIDITY")?.verdict).toBe("fail");
  });

  it("flags an exposure breach above the configured cap", () => {
    const concentrated = {
      ...healthySnapshot,
      portfolio: { ...healthySnapshot.portfolio, concentration: 0.55 },
    };
    const result = evaluatePolicy(balanced, assessment(30), concentrated, 10_000);
    expect(result.checks.find((c) => c.key === "MAX SINGLE ASSET")?.verdict).toBe("fail");
    expect(result.breached).toBe(true);
  });

  it("names the defensive asset and mode in the summary", () => {
    const manual = { ...balanced, mode: "MANUAL" as const };
    const result = evaluatePolicy(manual, assessment(60), healthySnapshot, 10_000);
    expect(result.summary).toContain("USDC");
    expect(result.summary).toContain("your approval");
  });
});

describe("constrain", () => {
  it("reduces an EXIT to the permitted REDUCE", () => {
    const evaluation = evaluatePolicy(balanced, assessment(60), healthySnapshot, 10_000);
    const out = constrain("EXIT", 10_000, evaluation);
    expect(out.action).toBe("REDUCE");
    expect(out.rotationBps).toBe(evaluation.permittedRotationBps);
    expect(out.wasReduced).toBe(true);
  });

  it("leaves a compliant proposal untouched", () => {
    const evaluation = evaluatePolicy(balanced, assessment(60), healthySnapshot, 10_000);
    const smaller = Math.max(1, evaluation.permittedRotationBps - 500);
    const out = constrain("REDUCE", smaller, evaluation);
    expect(out.action).toBe("REDUCE");
    expect(out.rotationBps).toBe(smaller);
    expect(out.wasReduced).toBe(false);
  });

  it("never lets a model exceed the policy ceiling", () => {
    const evaluation = evaluatePolicy(balanced, assessment(60), healthySnapshot, 10_000);
    const out = constrain("EXIT", 9_999, evaluation);
    expect(out.rotationBps).toBeLessThanOrEqual(POSTURE_MAX_ROTATION_BPS.Balanced);
  });

  it("downgrades an action with no rotation behind it to HOLD", () => {
    const evaluation = evaluatePolicy(balanced, assessment(60), healthySnapshot, 10_000);
    const out = constrain("REDUCE", 0, evaluation);
    expect(out.action).toBe("HOLD");
    expect(out.wasReduced).toBe(true);
  });

  it("blocks any action when the policy permits none", () => {
    const evaluation = evaluatePolicy(balanced, assessment(20), healthySnapshot, 10_000);
    const out = constrain("EXIT", 5_000, evaluation);
    expect(out.action).toBe("HOLD");
    expect(out.rotationBps).toBe(0);
  });
});

describe("cost versus downside", () => {
  it("rejects an intervention that costs more than the loss it avoids", () => {
    const result = isInterventionWorthwhile(100, 400, 3_500);
    expect(result.worthwhile).toBe(false);
    expect(result.netBenefitBps).toBeLessThan(0);
  });

  it("accepts an intervention whose avoided downside clears its cost", () => {
    const result = isInterventionWorthwhile(520, 140, 3_500);
    expect(result.worthwhile).toBe(true);
    expect(result.netBenefitBps).toBeGreaterThan(0);
  });

  it("scales both sides by the rotated fraction", () => {
    const half = isInterventionWorthwhile(500, 100, 5_000);
    const quarter = isInterventionWorthwhile(500, 100, 2_500);
    expect(half.netBenefitBps).toBeCloseTo(quarter.netBenefitBps * 2, 5);
  });
});

describe("downside model", () => {
  it("returns zero when the trajectory is flat", () => {
    expect(modelDownsideBps(assessment(40, 60, 40))).toBe(0);
  });

  it("scales with predicted deterioration and its likelihood", () => {
    const likely = modelDownsideBps(assessment(40, 90, 70));
    const unlikely = modelDownsideBps(assessment(40, 20, 70));
    expect(likely).toBeGreaterThan(unlikely);
  });
});

describe("slippage estimate", () => {
  it("grows with trade size and shrinks with depth", () => {
    const small = estimateSlippageBps(3_500, 2_400_000);
    const large = estimateSlippageBps(35_000, 2_400_000);
    const thin = estimateSlippageBps(3_500, 400_000);
    expect(large).toBeGreaterThan(small);
    expect(thin).toBeGreaterThan(small);
  });

  it("caps at 100% rather than returning nonsense on an empty pool", () => {
    expect(estimateSlippageBps(1_000, 0)).toBe(10_000);
  });

  it("produces a realistic figure for the reference rotation", () => {
    // $3,500 against a $2.4M pool should be roughly a percent, not a third.
    const bps = estimateSlippageBps(3_500, 2_400_000);
    expect(bps).toBeGreaterThan(10);
    expect(bps).toBeLessThan(200);
  });
});

describe("default policy is consistent with a new position", () => {
  it("derives an exposure cap above the position's starting concentration", () => {
    const cap = defaultExposureCapBps();
    const startingBps = Math.round(BASELINE_CONCENTRATION * 10_000);
    // A policy that is breached the moment it is created makes the breach
    // signal meaningless and drives a protective evaluation every cycle.
    expect(cap).toBeGreaterThan(startingBps);
  });

  it("never produces a breached cap for any starting concentration", () => {
    for (const concentration of [0.05, 0.15, 0.35, 0.61, 0.75, 0.88]) {
      const cap = defaultExposureCapBps(concentration);
      expect(cap).toBeGreaterThanOrEqual(Math.round(concentration * 10_000));
    }
  });

  it("stays inside the range the policy schema accepts", () => {
    for (const concentration of [0.01, 0.5, 0.99, 1]) {
      const cap = defaultExposureCapBps(concentration);
      expect(cap).toBeGreaterThanOrEqual(4_000);
      expect(cap).toBeLessThanOrEqual(10_000);
    }
  });

  it("leaves a freshly registered position unbreached but flagged as concentrated", () => {
    const freshPolicy = { ...balanced, maxExposureBps: defaultExposureCapBps() };
    const snapshot = {
      ...healthySnapshot,
      portfolio: { ...healthySnapshot.portfolio, concentration: BASELINE_CONCENTRATION },
    };
    const result = evaluatePolicy(freshPolicy, assessment(12), snapshot, 10_000);

    expect(result.breached).toBe(false);
    expect(result.permittedAction).toBe("HOLD");
    // Still surfaced as a warning — the concentration is genuinely high, the
    // user just hasn't opted into a tighter limit than reality.
    expect(result.checks.find((c) => c.key === "MAX SINGLE ASSET")?.verdict).toBe("warn");
  });
});
