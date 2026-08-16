import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProtectionPolicy, RiskAssessment, SignalSnapshot } from "../domain/types.js";

// The Guardian must hold the policy line whether or not the model is reachable,
// so the AI transport is mocked and driven from each test.
const callStructured = vi.hoisted(() => vi.fn());
vi.mock("./client.js", () => ({ callStructured, aiAvailable: () => true }));

const { decide } = await import("./guardian.js");
const { POSTURE_MAX_ROTATION_BPS } = await import("../risk/policy.js");

const policy: ProtectionPolicy = {
  positionId: "pos_1",
  posture: "Balanced",
  maxDrawdownBps: 1_000,
  maxExposureBps: 4_000,
  minLiquidityUsd: 250_000,
  defensiveAsset: "USDC",
  mode: "AUTO",
  updatedAt: Date.now(),
};

const snapshot: SignalSnapshot = {
  positionId: "pos_1",
  capturedAt: Date.now(),
  market: {
    volatilityPct: 9,
    priceDeviationPct: 4,
    drawdownPct: 6,
    volumeChangePct: 30,
    priceUsd: 1,
    source: "live",
  },
  asset: {
    issuerEventActive: true,
    issuerEventSeverity: 0.85,
    daysToNextRepayment: 3,
    description: "Repayment delay flagged",
  },
  onchain: {
    oracleDeviationSigma: 2.4,
    liquidityDepthUsd: 1_400_000,
    depthChangePct: -38,
    poolImbalance: 0.6,
    oracleStalenessSeconds: 30,
  },
  portfolio: {
    concentration: 0.61,
    correlatedExposure: 0.55,
    positionDrawdownPct: 4.5,
    defensiveShare: 0,
  },
};

function assessment(overrides: Partial<RiskAssessment> = {}): RiskAssessment {
  return {
    id: "asm_1",
    positionId: "pos_1",
    createdAt: Date.now(),
    compositeScore: 74,
    band: "HIGH",
    confidence: 84,
    escalationProbability: 78,
    recommendedAction: "EXIT",
    classScores: { market: 68, asset: 86, onchain: 68, portfolio: 46, predictive: 84 },
    factors: [],
    trajectory: [
      { hour: 0, score: 74 },
      { hour: 6, score: 92 },
    ],
    reasoning: "Issuer delay with thinning depth and oracle deviation.",
    source: "deterministic",
    ...overrides,
  };
}

beforeEach(() => {
  callStructured.mockReset();
});

describe("Guardian — deterministic path (model unavailable)", () => {
  beforeEach(() => callStructured.mockResolvedValue(null));

  it("reduces the Analyst's EXIT to a bounded REDUCE", async () => {
    const decision = await decide({
      assessment: assessment(),
      policy,
      snapshot,
      positionValueUsd: 10_000,
    });

    expect(decision.proposedAction).toBe("EXIT");
    expect(decision.finalAction).toBe("REDUCE");
    expect(decision.rotationBps).toBeGreaterThan(0);
    expect(decision.rotationBps).toBeLessThanOrEqual(POSTURE_MAX_ROTATION_BPS.Balanced);
    expect(decision.source).toBe("deterministic");
    expect(decision.status).toBe("pending");
    // The verdict must record that the Analyst's EXIT was overridden.
    expect(decision.policyMatch).toMatch(/EXIT exceeds Balanced posture/);
  });

  it("holds when the policy authorises nothing", async () => {
    const decision = await decide({
      assessment: assessment({ compositeScore: 18, band: "LOW", recommendedAction: "HOLD" }),
      policy,
      snapshot: {
        ...snapshot,
        portfolio: { ...snapshot.portfolio, concentration: 0.3, positionDrawdownPct: 0.2 },
        onchain: { ...snapshot.onchain, liquidityDepthUsd: 2_400_000 },
      },
      positionValueUsd: 10_000,
    });

    expect(decision.finalAction).toBe("HOLD");
    expect(decision.rotationBps).toBe(0);
    expect(decision.amountUsd).toBe(0);
  });

  it("refuses to act when execution costs more than the downside avoided", async () => {
    const decision = await decide({
      // Escalation is real but tiny, so the modelled downside is negligible…
      assessment: assessment({ escalationProbability: 5, trajectory: [
        { hour: 0, score: 74 },
        { hour: 6, score: 75 },
      ] }),
      policy,
      // …while the pool is thin enough to make the swap expensive.
      snapshot: { ...snapshot, onchain: { ...snapshot.onchain, liquidityDepthUsd: 60_000 } },
      positionValueUsd: 10_000,
    });

    expect(decision.finalAction).toBe("HOLD");
    expect(decision.rotationBps).toBe(0);
    expect(decision.checks.find((c) => c.key === "COST VS DOWNSIDE")?.verdict).toBe("fail");
    expect(decision.rationale).toMatch(/costs more than the loss it prevents/i);
  });

  it("intervenes sooner under a Conservative posture", async () => {
    const mild = assessment({ compositeScore: 42, band: "MEDIUM", recommendedAction: "REDUCE" });
    const conservative = await decide({
      assessment: mild,
      policy: { ...policy, posture: "Conservative" },
      snapshot,
      positionValueUsd: 10_000,
    });
    const aggressive = await decide({
      assessment: mild,
      policy: { ...policy, posture: "Aggressive" },
      snapshot: {
        ...snapshot,
        portfolio: { ...snapshot.portfolio, concentration: 0.3, positionDrawdownPct: 0.2 },
      },
      positionValueUsd: 10_000,
    });

    expect(conservative.finalAction).toBe("REDUCE");
    expect(aggressive.finalAction).toBe("HOLD");
  });
});

describe("Guardian — model path", () => {
  it("uses the model's action and rationale when it stays inside the policy", async () => {
    callStructured.mockResolvedValue({
      finalAction: "REDUCE",
      rotationBps: 2_000,
      rationale:
        "A partial rotation contains the issuer risk without liquidating exposure the investor chose to hold.",
      policyMatch: "Within posture",
    });

    const decision = await decide({
      assessment: assessment(),
      policy,
      snapshot,
      positionValueUsd: 10_000,
    });

    expect(decision.source).toBe("ai");
    expect(decision.finalAction).toBe("REDUCE");
    expect(decision.rotationBps).toBe(2_000);
    expect(decision.amountUsd).toBe(2_000);
    expect(decision.rationale).toContain("partial rotation");
    // The model picked REDUCE where the Analyst asked for EXIT — that is an
    // override, and the verdict says so rather than echoing the model's label.
    expect(decision.policyMatch).toMatch(/EXIT exceeds Balanced posture/);
  });

  it("keeps the model's own verdict when it agrees with the Analyst", async () => {
    callStructured.mockResolvedValue({
      finalAction: "REDUCE",
      rotationBps: 2_000,
      rationale: "The Analyst's REDUCE is proportionate to the issuer risk.",
      policyMatch: "Within posture",
    });

    const decision = await decide({
      assessment: assessment({ recommendedAction: "REDUCE" }),
      policy,
      snapshot,
      positionValueUsd: 10_000,
    });

    expect(decision.proposedAction).toBe("REDUCE");
    expect(decision.finalAction).toBe("REDUCE");
    expect(decision.policyMatch).toBe("Within posture");
  });

  it("clamps a model that asks for more than the policy permits", async () => {
    callStructured.mockResolvedValue({
      finalAction: "EXIT",
      rotationBps: 10_000,
      rationale: "Liquidate everything immediately.",
      policyMatch: "Severe risk",
    });

    const decision = await decide({
      assessment: assessment(),
      policy,
      snapshot,
      positionValueUsd: 10_000,
    });

    expect(decision.finalAction).toBe("REDUCE");
    expect(decision.rotationBps).toBeLessThanOrEqual(POSTURE_MAX_ROTATION_BPS.Balanced);
    expect(decision.rationale).toMatch(/clamped to the policy ceiling/i);
    expect(decision.policyMatch).toMatch(/exceeds/i);
  });

  it("clamps a model that invents an out-of-range rotation", async () => {
    callStructured.mockResolvedValue({
      finalAction: "REDUCE",
      rotationBps: 9_999,
      rationale: "Rotate almost everything.",
      policyMatch: "Within posture",
    });

    const decision = await decide({
      assessment: assessment(),
      policy,
      snapshot,
      positionValueUsd: 10_000,
    });

    expect(decision.rotationBps).toBeLessThanOrEqual(POSTURE_MAX_ROTATION_BPS.Balanced);
  });

  it("overrides the model when the economics do not clear", async () => {
    callStructured.mockResolvedValue({
      finalAction: "REDUCE",
      rotationBps: 3_000,
      rationale: "Trim exposure.",
      policyMatch: "Within posture",
    });

    const decision = await decide({
      assessment: assessment({
        escalationProbability: 4,
        trajectory: [
          { hour: 0, score: 74 },
          { hour: 6, score: 74.5 },
        ],
      }),
      policy,
      snapshot: { ...snapshot, onchain: { ...snapshot.onchain, liquidityDepthUsd: 50_000 } },
      positionValueUsd: 10_000,
    });

    expect(decision.finalAction).toBe("HOLD");
    expect(decision.rationale).toMatch(/execution cost exceeded the modelled downside/i);
  });

  it("falls back cleanly when the model returns nothing", async () => {
    callStructured.mockResolvedValue(null);
    const decision = await decide({
      assessment: assessment(),
      policy,
      snapshot,
      positionValueUsd: 10_000,
    });
    expect(decision.source).toBe("deterministic");
    expect(decision.rationale.length).toBeGreaterThan(40);
  });

  it("records every policy check on the decision", async () => {
    callStructured.mockResolvedValue(null);
    const decision = await decide({
      assessment: assessment(),
      policy,
      snapshot,
      positionValueUsd: 10_000,
    });

    const keys = decision.checks.map((c) => c.key);
    expect(keys).toContain("MAX DRAWDOWN");
    expect(keys).toContain("MAX SINGLE ASSET");
    expect(keys).toContain("MIN LIQUIDITY");
    expect(keys).toContain("POSTURE THRESHOLD");
    expect(keys).toContain("COST VS DOWNSIDE");
    expect(keys).toContain("MIN. EFFECTIVE ACTION");
  });
});
