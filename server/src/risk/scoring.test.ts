import { describe, expect, it } from "vitest";
import type { SignalSnapshot } from "../domain/types.js";
import { bandOf } from "../domain/types.js";
import {
  BASELINE_RISK,
  CLASS_WEIGHTS,
  compositeScore,
  confidenceOf,
  escalationProbability,
  projectTrajectory,
  ramp,
  scoreAsset,
  scoreClasses,
  scoreMarket,
  scoreOnchain,
  scorePortfolio,
  topFactors,
} from "./scoring.js";

const calm: SignalSnapshot = {
  positionId: "pos_test",
  capturedAt: Date.now(),
  market: {
    volatilityPct: 1.4,
    priceDeviationPct: 0.2,
    drawdownPct: 0.3,
    volumeChangePct: 8,
    priceUsd: 1,
    source: "live",
  },
  asset: {
    issuerEventActive: false,
    issuerEventSeverity: 0,
    daysToNextRepayment: 45,
    description: "No issuer events",
  },
  onchain: {
    oracleDeviationSigma: 0.2,
    liquidityDepthUsd: 2_400_000,
    depthChangePct: 1.5,
    poolImbalance: 0.08,
    oracleStalenessSeconds: 20,
  },
  portfolio: {
    concentration: 0.3,
    correlatedExposure: 0.2,
    positionDrawdownPct: 0.4,
    defensiveShare: 0,
  },
};

const stressed: SignalSnapshot = {
  ...calm,
  market: { ...calm.market, volatilityPct: 9.2, priceDeviationPct: 4.1, drawdownPct: 12 },
  asset: {
    issuerEventActive: true,
    issuerEventSeverity: 0.85,
    daysToNextRepayment: 3,
    description: "Repayment delay flagged",
  },
  onchain: {
    oracleDeviationSigma: 2.4,
    liquidityDepthUsd: 420_000,
    depthChangePct: -38,
    poolImbalance: 0.62,
    oracleStalenessSeconds: 45,
  },
  portfolio: { ...calm.portfolio, concentration: 0.61, correlatedExposure: 0.55 },
};

describe("ramp", () => {
  it("floors below the benign threshold and caps above the severe one", () => {
    expect(ramp(0.5, 1, 10)).toBe(0);
    expect(ramp(1, 1, 10)).toBe(0);
    expect(ramp(10, 1, 10)).toBe(100);
    expect(ramp(50, 1, 10)).toBe(100);
  });

  it("passes through 50 at the midpoint", () => {
    expect(ramp(5.5, 1, 10)).toBe(50);
  });

  it("suppresses noise near the benign end and saturates near the severe end", () => {
    // 10% of the way in reads well under 10; 90% reads well over 90.
    expect(ramp(1.9, 1, 10)).toBeLessThan(10);
    expect(ramp(9.1, 1, 10)).toBeGreaterThan(90);
  });

  it("is monotonically non-decreasing across the range", () => {
    let previous = -1;
    for (let v = 0; v <= 11; v += 0.25) {
      const score = ramp(v, 1, 10);
      expect(score).toBeGreaterThanOrEqual(previous);
      previous = score;
    }
  });

  it("handles a degenerate range without dividing by zero", () => {
    expect(ramp(5, 5, 5)).toBe(100);
    expect(ramp(4, 5, 5)).toBe(0);
  });
});

describe("class scores", () => {
  it("scores a calm position low across every class", () => {
    const classes = scoreClasses(calm);
    expect(classes.market).toBeLessThan(20);
    expect(classes.asset).toBeLessThan(20);
    expect(classes.onchain).toBeLessThan(20);
    expect(classes.portfolio).toBeLessThan(30);
    expect(compositeScore(classes)).toBeLessThan(25);
    expect(bandOf(compositeScore(classes))).toBe("LOW");
  });

  it("scores a stressed position into the HIGH band or worse", () => {
    const classes = scoreClasses(stressed);
    const composite = compositeScore(classes);
    expect(composite).toBeGreaterThan(50);
    expect(["HIGH", "CRITICAL"]).toContain(bandOf(composite));
  });

  it("is monotonic — worsening one signal never lowers its class score", () => {
    const worse = scoreOnchain({ ...calm.onchain, oracleDeviationSigma: 2.8 });
    const base = scoreOnchain(calm.onchain);
    expect(worse).toBeGreaterThan(base);
  });

  it("treats a volume collapse as seriously as a volume spike", () => {
    const spike = scoreMarket({ ...calm.market, volumeChangePct: 180 });
    const collapse = scoreMarket({ ...calm.market, volumeChangePct: -180 });
    expect(spike).toBe(collapse);
  });

  it("weights an issuer event near a repayment date above a distant one", () => {
    const near = scoreAsset({
      issuerEventActive: true,
      issuerEventSeverity: 0.8,
      daysToNextRepayment: 2,
      description: "x",
    });
    const far = scoreAsset({
      issuerEventActive: true,
      issuerEventSeverity: 0.8,
      daysToNextRepayment: 60,
      description: "x",
    });
    expect(near).toBeGreaterThan(far);
  });

  it("credits a defensive allocation as genuine risk reduction", () => {
    const exposed = scorePortfolio({ ...calm.portfolio, concentration: 0.8, defensiveShare: 0 });
    const rotated = scorePortfolio({ ...calm.portfolio, concentration: 0.8, defensiveShare: 0.4 });
    expect(rotated).toBeLessThan(exposed);
  });
});

describe("composite", () => {
  it("uses weights that sum to one", () => {
    const sum = Object.values(CLASS_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("floors at the residual risk baseline and caps at 100", () => {
    const zero = compositeScore({ market: 0, asset: 0, onchain: 0, portfolio: 0, predictive: 0 });
    const full = compositeScore({
      market: 100,
      asset: 100,
      onchain: 100,
      portfolio: 100,
      predictive: 100,
    });
    // A fully nominal position still carries unmonitored residual risk.
    expect(zero).toBe(BASELINE_RISK);
    expect(full).toBe(100);
  });

  it("is deterministic — identical snapshots produce identical scores", () => {
    expect(compositeScore(scoreClasses(stressed))).toBe(compositeScore(scoreClasses(stressed)));
  });
});

describe("predictive class", () => {
  it("rises when the picture is deteriorating between cycles", () => {
    const previous = scoreClasses(calm);
    const flat = scoreClasses(stressed);
    const withMomentum = scoreClasses(stressed, previous);
    expect(withMomentum.predictive).toBeGreaterThan(flat.predictive);
  });
});

describe("confidence", () => {
  it("is higher when the classes agree", () => {
    const agree = confidenceOf(
      { market: 60, asset: 60, onchain: 60, portfolio: 60, predictive: 60 },
      calm,
    );
    const disagree = confidenceOf(
      { market: 5, asset: 95, onchain: 10, portfolio: 90, predictive: 50 },
      calm,
    );
    expect(agree).toBeGreaterThan(disagree);
  });

  it("is penalised by a stale oracle", () => {
    const fresh = confidenceOf(scoreClasses(calm), calm);
    const stale = confidenceOf(scoreClasses(calm), {
      ...calm,
      onchain: { ...calm.onchain, oracleStalenessSeconds: 600 },
    });
    expect(stale).toBeLessThan(fresh);
  });

  it("never claims more than 97% or less than 40%", () => {
    const c = confidenceOf({ market: 50, asset: 50, onchain: 50, portfolio: 50, predictive: 50 }, calm);
    expect(c).toBeLessThanOrEqual(97);
    expect(c).toBeGreaterThanOrEqual(40);
  });
});

describe("escalation probability", () => {
  it("rises as the score approaches the next band edge", () => {
    const classes = { market: 40, asset: 40, onchain: 40, portfolio: 40, predictive: 40 };
    const farFromEdge = escalationProbability(26, classes);
    const nearEdge = escalationProbability(49, classes);
    expect(nearEdge).toBeGreaterThan(farFromEdge);
  });
});

describe("trajectory", () => {
  it("starts at the present score and approaches the predictive class", () => {
    const classes = { market: 30, asset: 30, onchain: 30, portfolio: 30, predictive: 80 };
    const path = projectTrajectory(30, classes, 6);
    expect(path[0]!.score).toBe(30);
    expect(path.at(-1)!.score).toBeGreaterThan(70);
    expect(path.at(-1)!.hour).toBe(6);
  });

  it("decays downward when prediction is below the present score", () => {
    const classes = { market: 20, asset: 20, onchain: 20, portfolio: 20, predictive: 20 };
    const path = projectTrajectory(70, classes, 6);
    expect(path.at(-1)!.score).toBeLessThan(30);
  });
});

describe("top factors", () => {
  it("returns four ranked drivers whose weights sum to roughly the explained share", () => {
    const classes = scoreClasses(stressed);
    const factors = topFactors(stressed, classes);
    expect(factors).toHaveLength(4);
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i - 1]!.weight).toBeGreaterThanOrEqual(factors[i]!.weight);
    }
    const sum = factors.reduce((a, f) => a + f.weight, 0);
    expect(sum).toBeGreaterThan(0);
    expect(sum).toBeLessThanOrEqual(1);
  });

  it("names the issuer event when one is live", () => {
    const factors = topFactors(stressed, scoreClasses(stressed));
    expect(factors.some((f) => f.label.includes("Repayment delay flagged"))).toBe(true);
  });
});
