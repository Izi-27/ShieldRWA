import {
  type AssetSignals,
  type ClassScores,
  type MarketSignals,
  type OnchainSignals,
  type PortfolioSignals,
  type RiskFactor,
  type SignalSnapshot,
  type TrajectoryPoint,
  clamp,
} from "../domain/types.js";

/**
 * Deterministic risk scoring.
 *
 * Every signal is mapped onto 0-100 by an explicit, documented transform, then
 * the five classes are combined with fixed weights. Nothing here is stochastic
 * or model-dependent: the same signals always produce the same score, so the
 * number anchored on chain is reproducible from the snapshot beside it.
 */

/** Composite weights per signal class. Must sum to 1. */
export const CLASS_WEIGHTS = {
  market: 0.2,
  asset: 0.2,
  onchain: 0.3,
  portfolio: 0.15,
  predictive: 0.15,
} as const;

/**
 * Residual risk floor. No tokenised position is risk-free: smart-contract,
 * custody and market-structure risk remain even when every monitored signal is
 * nominal. Reporting a literal zero would overstate what monitoring can tell
 * you, and would leave the meter dead until a threshold is crossed.
 */
export const BASELINE_RISK = 6;

/**
 * Maps a raw reading onto 0-100 with a smoothstep curve: flat near `benign` so
 * ordinary noise doesn't move the score, steepest through the middle where a
 * reading is genuinely deteriorating, and flattening again near `severe` where
 * things are already bad and further deterioration adds little information.
 *
 * A plain quadratic was tried first and rejected: it kept its shallow slope all
 * the way to the top, so a 2.4σ oracle deviation — a serious event — scored 58
 * where it should sit in the mid-80s.
 */
export function ramp(value: number, benign: number, severe: number): number {
  if (severe === benign) return value >= severe ? 100 : 0;
  const t = (value - benign) / (severe - benign);
  if (t <= 0) return 0;
  if (t >= 1) return 100;
  return clamp(Math.round(t * t * (3 - 2 * t) * 100));
}

/** Linear variant, for readings where the relationship is not convex. */
export function linear(value: number, benign: number, severe: number): number {
  if (severe === benign) return value >= severe ? 100 : 0;
  const t = (value - benign) / (severe - benign);
  return clamp(Math.round(t * 100));
}

export function scoreMarket(s: MarketSignals): number {
  const volatility = ramp(s.volatilityPct, 0.8, 12);
  const deviation = ramp(Math.abs(s.priceDeviationPct), 0.15, 6);
  const drawdown = ramp(Math.abs(s.drawdownPct), 0.5, 20);
  // A volume collapse is as informative as a volume spike.
  const volumeShock = ramp(Math.abs(s.volumeChangePct), 25, 200);
  return clamp(
    Math.round(volatility * 0.35 + deviation * 0.3 + drawdown * 0.25 + volumeShock * 0.1),
  );
}

export function scoreAsset(s: AssetSignals): number {
  if (!s.issuerEventActive) {
    // No issuer event: the only asset-level risk is proximity to a repayment.
    return clamp(Math.round(linear(30 - Math.min(s.daysToNextRepayment, 30), 0, 30) * 0.35));
  }
  const eventSeverity = clamp(Math.round(s.issuerEventSeverity * 100));
  // An event close to a repayment date is materially worse than a distant one.
  const proximity = linear(30 - Math.min(s.daysToNextRepayment, 30), 0, 30);
  return clamp(Math.round(eventSeverity * 0.8 + proximity * 0.2));
}

export function scoreOnchain(s: OnchainSignals): number {
  const deviation = ramp(Math.abs(s.oracleDeviationSigma), 0.15, 3);
  const thinning = ramp(Math.abs(Math.min(s.depthChangePct, 0)), 3, 60);
  // Absolute depth matters as well as its rate of change.
  const depth = ramp(1_000_000 - Math.min(s.liquidityDepthUsd, 1_000_000), 100_000, 900_000);
  const imbalance = linear(s.poolImbalance, 0.05, 0.8);
  const staleness = ramp(s.oracleStalenessSeconds, 60, 900);
  return clamp(
    Math.round(
      deviation * 0.3 + thinning * 0.25 + depth * 0.2 + imbalance * 0.15 + staleness * 0.1,
    ),
  );
}

export function scorePortfolio(s: PortfolioSignals): number {
  const concentration = ramp(s.concentration, 0.1, 0.9);
  const correlated = ramp(s.correlatedExposure, 0.1, 0.9);
  const drawdown = ramp(Math.abs(s.positionDrawdownPct), 0.5, 20);
  // Holding defensive assets genuinely reduces portfolio risk.
  const liquidityRelief = linear(s.defensiveShare, 0, 0.5);
  const raw = concentration * 0.4 + correlated * 0.3 + drawdown * 0.3;
  return clamp(Math.round(raw * (1 - 0.35 * (liquidityRelief / 100))));
}

/**
 * Predictive class: whether current conditions are likely to escalate.
 * Built from the *direction* of the other classes plus the signals that
 * historically lead deterioration (thinning depth, live issuer events).
 */
export function scorePredictive(
  snapshot: SignalSnapshot,
  present: Omit<ClassScores, "predictive">,
  previous?: Omit<ClassScores, "predictive">,
): number {
  const currentPressure =
    present.market * 0.25 + present.asset * 0.25 + present.onchain * 0.35 + present.portfolio * 0.15;

  // Momentum: how fast the picture is deteriorating since the last cycle.
  const momentum = previous
    ? clamp(
        ((present.market - previous.market) * 0.25 +
          (present.asset - previous.asset) * 0.25 +
          (present.onchain - previous.onchain) * 0.35 +
          (present.portfolio - previous.portfolio) * 0.15) *
          4,
        -40,
        40,
      )
    : 0;

  // Leading indicators that tend to precede a band change.
  const thinning = ramp(Math.abs(Math.min(snapshot.onchain.depthChangePct, 0)), 10, 50);
  const issuerPressure = snapshot.asset.issuerEventActive
    ? clamp(snapshot.asset.issuerEventSeverity * 100)
    : 0;

  return clamp(
    Math.round(currentPressure * 0.6 + momentum + thinning * 0.2 + issuerPressure * 0.2),
  );
}

export function scoreClasses(
  snapshot: SignalSnapshot,
  previous?: ClassScores,
): ClassScores {
  const base = {
    market: scoreMarket(snapshot.market),
    asset: scoreAsset(snapshot.asset),
    onchain: scoreOnchain(snapshot.onchain),
    portfolio: scorePortfolio(snapshot.portfolio),
  };
  return { ...base, predictive: scorePredictive(snapshot, base, previous) };
}

export function compositeScore(classes: ClassScores): number {
  const raw =
    classes.market * CLASS_WEIGHTS.market +
    classes.asset * CLASS_WEIGHTS.asset +
    classes.onchain * CLASS_WEIGHTS.onchain +
    classes.portfolio * CLASS_WEIGHTS.portfolio +
    classes.predictive * CLASS_WEIGHTS.predictive;
  // Compress the weighted score into the range above the residual floor so the
  // floor never pushes a genuinely severe reading past 100.
  const scaled = BASELINE_RISK + (raw * (100 - BASELINE_RISK)) / 100;
  return clamp(Math.round(scaled * 10) / 10);
}

/**
 * Confidence reflects how much the classes agree. Tight agreement across five
 * independent signal families is a stronger read than one class screaming while
 * the rest are calm. Stale oracle data caps confidence.
 */
export function confidenceOf(classes: ClassScores, snapshot: SignalSnapshot): number {
  const values = Object.values(classes);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const spread = Math.sqrt(variance);

  // 0 spread → 95%, 40+ spread → 55%.
  let confidence = clamp(95 - (spread / 40) * 40, 50, 95);

  if (snapshot.onchain.oracleStalenessSeconds > 300) confidence -= 10;
  if (snapshot.market.source === "simulated") confidence -= 5;

  return clamp(Math.round(confidence), 40, 97);
}

/**
 * Probability the position enters a materially worse band within the horizon.
 * Rises with the predictive class and with proximity to the next band edge.
 */
export function escalationProbability(composite: number, classes: ClassScores): number {
  const nextEdge = composite < 25 ? 25 : composite < 50 ? 50 : composite < 75 ? 75 : 100;
  const distance = nextEdge - composite; // 0-25
  const proximity = clamp(100 - (distance / 25) * 100);
  return clamp(Math.round(classes.predictive * 0.6 + proximity * 0.4));
}

/** Ranks the individual drivers behind the composite, largest contribution first. */
export function topFactors(snapshot: SignalSnapshot, classes: ClassScores): RiskFactor[] {
  const candidates: RiskFactor[] = [
    {
      label: `Oracle deviation ${snapshot.onchain.oracleDeviationSigma.toFixed(1)}σ`,
      severity: ramp(Math.abs(snapshot.onchain.oracleDeviationSigma), 0.15, 3),
      weight: 0,
    },
    {
      label: `Liquidity depth ${snapshot.onchain.depthChangePct.toFixed(0)}%`,
      severity: ramp(Math.abs(Math.min(snapshot.onchain.depthChangePct, 0)), 3, 60),
      weight: 0,
    },
    {
      label: snapshot.asset.issuerEventActive
        ? `Issuer event — ${snapshot.asset.description}`
        : "Issuer feed nominal",
      severity: classes.asset,
      weight: 0,
    },
    {
      label: `Concentration ${(snapshot.portfolio.concentration * 100).toFixed(0)}%`,
      severity: ramp(snapshot.portfolio.concentration, 0.1, 0.9),
      weight: 0,
    },
    {
      label: `Volatility ${snapshot.market.volatilityPct.toFixed(1)}%`,
      severity: ramp(snapshot.market.volatilityPct, 0.8, 12),
      weight: 0,
    },
    {
      label: `Price deviation ${Math.abs(snapshot.market.priceDeviationPct).toFixed(1)}%`,
      severity: ramp(Math.abs(snapshot.market.priceDeviationPct), 0.15, 6),
      weight: 0,
    },
  ];

  const total = candidates.reduce((a, f) => a + f.severity, 0);
  if (total === 0) {
    return candidates.slice(0, 4).map((f) => ({ ...f, weight: 0 }));
  }

  return candidates
    .map((f) => ({ ...f, weight: Math.round((f.severity / total) * 1000) / 1000 }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4);
}

/**
 * Projects the composite forward over the horizon. The path bends toward the
 * predictive class: when prediction exceeds the current score the curve rises,
 * and it decays back toward the present reading when prediction is lower.
 */
export function projectTrajectory(
  composite: number,
  classes: ClassScores,
  horizonHours: number,
  steps = 24,
): TrajectoryPoint[] {
  const target = classes.predictive;
  const points: TrajectoryPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Exponential approach: fast at first, flattening toward the target.
    const progress = 1 - Math.exp(-3 * t);
    points.push({
      hour: Math.round(t * horizonHours * 10) / 10,
      score: clamp(Math.round((composite + (target - composite) * progress) * 10) / 10),
    });
  }
  return points;
}
