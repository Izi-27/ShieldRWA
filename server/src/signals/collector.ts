import { BASELINE_CONCENTRATION } from "../domain/types.js";
import type {
  AssetSignals,
  InjectedEvent,
  OnchainSignals,
  PortfolioSignals,
  Position,
  SignalSnapshot,
} from "../domain/types.js";
import type { MarketProvider } from "./market.js";

/**
 * DETECT stage: assemble one snapshot across all five signal classes.
 *
 * Market data comes from the configured provider. On-chain pool state comes
 * from a depth model that reacts to live liquidity/oracle events; where the
 * chain is configured, the vault's real defensive share is read and folded into
 * the portfolio class. Controlled events injected through the API are applied
 * on top, so an operator-triggered scenario moves the same signals a real one
 * would.
 */

export interface ChainPositionState {
  /** Fraction of the vault currently held in the defensive asset. */
  defensiveShare: number;
  /** Total vault value expressed in asset units. */
  totalAssets: number;
}

export interface CollectorInput {
  position: Position;
  injectedEvents: InjectedEvent[];
  chainState?: ChainPositionState | null;
  /** Baseline pool depth for the asset, in USD. */
  baselineDepthUsd?: number;
}

/** Pool depth model — a healthy pool that thins under liquidity events. */
function deriveOnchain(
  input: CollectorInput,
  now: number,
): OnchainSignals {
  const baseline = input.baselineDepthUsd ?? 2_400_000;

  const liquidityEvent = input.injectedEvents.find((e) => e.kind === "liquidity");
  const oracleEvent = input.injectedEvents.find((e) => e.kind === "oracle");

  // A liquidity event withdraws up to 85% of depth at full severity.
  const depthLossFraction = liquidityEvent ? liquidityEvent.severity * 0.85 : 0;
  const depth = baseline * (1 - depthLossFraction);

  // Report the change against the baseline the pool was at before the event.
  const depthChangePct = liquidityEvent ? -depthLossFraction * 100 : jitter(now, 1.5);

  // Oracle deviation: nominal noise, or the event's severity mapped onto sigma.
  const deviationSigma = oracleEvent
    ? 0.2 + oracleEvent.severity * 3.0
    : 0.1 + Math.abs(jitter(now + 7, 0.25));

  // Depth loss skews the pool.
  const imbalance = Math.min(0.95, 0.06 + depthLossFraction * 0.8);

  return {
    oracleDeviationSigma: round(deviationSigma, 2),
    liquidityDepthUsd: Math.round(depth),
    depthChangePct: round(depthChangePct, 1),
    poolImbalance: round(imbalance, 3),
    // The oracle keeps its heartbeat unless an oracle event is degrading it.
    oracleStalenessSeconds: oracleEvent ? Math.round(30 + oracleEvent.severity * 600) : 25,
  };
}

function deriveAsset(input: CollectorInput): AssetSignals {
  const issuerEvent = input.injectedEvents.find((e) => e.kind === "issuer");
  if (!issuerEvent) {
    return {
      issuerEventActive: false,
      issuerEventSeverity: 0,
      daysToNextRepayment: 45,
      description: "Issuer feed synced — no events",
    };
  }
  return {
    issuerEventActive: true,
    issuerEventSeverity: round(issuerEvent.severity, 3),
    // A live issuer event is reported against the imminent repayment.
    daysToNextRepayment: 3,
    description: issuerEvent.description,
  };
}

function derivePortfolio(input: CollectorInput, onchain: OnchainSignals): PortfolioSignals {
  const defensiveShare = input.chainState?.defensiveShare ?? 0;

  // Single-asset vault: concentration is whatever is not yet rotated out.
  const concentration = Math.max(0.05, BASELINE_CONCENTRATION * (1 - defensiveShare));

  // Correlated exposure rises with issuer stress across the same asset class.
  const issuerEvent = input.injectedEvents.find((e) => e.kind === "issuer");
  const correlatedExposure = Math.min(
    0.95,
    0.2 + (issuerEvent ? issuerEvent.severity * 0.5 : 0),
  );

  // Position drawdown tracks the pool's depth loss as a proxy for mark impact.
  const positionDrawdownPct = onchain.depthChangePct < 0 ? onchain.depthChangePct * 0.12 : 0;

  return {
    concentration: round(concentration, 3),
    correlatedExposure: round(correlatedExposure, 3),
    positionDrawdownPct: round(positionDrawdownPct, 2),
    defensiveShare: round(defensiveShare, 4),
  };
}

export async function collectSignals(
  marketProvider: MarketProvider,
  input: CollectorInput,
  now = Date.now(),
): Promise<SignalSnapshot> {
  const market = await marketProvider.sample();
  const onchain = deriveOnchain(input, now);
  const asset = deriveAsset(input);
  const portfolio = derivePortfolio(input, onchain);

  // An oracle event is, by definition, a price-deviation event: reflect it in
  // the market class too rather than confining it to the on-chain class.
  const oracleEvent = input.injectedEvents.find((e) => e.kind === "oracle");
  const adjustedMarket = oracleEvent
    ? {
        ...market,
        priceDeviationPct: round(
          market.priceDeviationPct + oracleEvent.severity * 4.5 * Math.sign(market.priceDeviationPct || 1),
          3,
        ),
        volatilityPct: round(market.volatilityPct + oracleEvent.severity * 6, 3),
      }
    : market;

  return {
    positionId: input.position.id,
    capturedAt: now,
    market: adjustedMarket,
    asset,
    onchain,
    portfolio,
  };
}

/** Small deterministic wobble so idle readings are not perfectly static. */
function jitter(seed: number, amplitude: number): number {
  const x = Math.sin(seed / 30_000) * 10_000;
  return (x - Math.floor(x) - 0.5) * 2 * amplitude;
}

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}
