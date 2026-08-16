import { config } from "../config.js";
import { logger } from "../logger.js";
import type { MarketSignals } from "../domain/types.js";

/**
 * Market signal providers.
 *
 * `coingecko` reads a real public price feed and derives volatility, deviation
 * and drawdown from the returned series. `simulated` runs a seeded random walk
 * for offline development. Whichever is used is reported on the snapshot as
 * `source`, so the dashboard never presents simulated numbers as live ones.
 */

export interface MarketProvider {
  readonly kind: "live" | "simulated";
  sample(): Promise<MarketSignals>;
}

interface PricePoint {
  at: number;
  price: number;
}

/** Rolling window used to derive volatility and drawdown from raw prices. */
class PriceWindow {
  private readonly points: PricePoint[] = [];

  constructor(private readonly maxPoints = 120) {}

  push(price: number, at = Date.now()): void {
    this.points.push({ at, price });
    if (this.points.length > this.maxPoints) this.points.shift();
  }

  get size(): number {
    return this.points.length;
  }

  latest(): number | undefined {
    return this.points.at(-1)?.price;
  }

  /** Standard deviation of log returns, expressed as a percentage. */
  volatilityPct(): number {
    if (this.points.length < 3) return 0;
    const returns: number[] = [];
    for (let i = 1; i < this.points.length; i++) {
      const prev = this.points[i - 1]!.price;
      const curr = this.points[i]!.price;
      if (prev > 0 && curr > 0) returns.push(Math.log(curr / prev));
    }
    if (returns.length < 2) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
    return Math.sqrt(variance) * 100;
  }

  /** Drawdown from the window's high, as a negative percentage. */
  drawdownPct(): number {
    if (this.points.length < 2) return 0;
    const high = Math.max(...this.points.map((p) => p.price));
    const last = this.points.at(-1)!.price;
    if (high <= 0) return 0;
    return ((last - high) / high) * 100;
  }

  /** Deviation of the last price from the window mean, as a percentage. */
  deviationPct(): number {
    if (this.points.length < 2) return 0;
    const mean = this.points.reduce((a, p) => a + p.price, 0) / this.points.length;
    if (mean <= 0) return 0;
    return ((this.points.at(-1)!.price - mean) / mean) * 100;
  }
}

/** Reads a real price series from the CoinGecko public API. */
export class CoinGeckoProvider implements MarketProvider {
  readonly kind = "live" as const;
  private readonly window = new PriceWindow();
  private lastVolume = 0;
  private lastVolumeChangePct = 0;
  private consecutiveFailures = 0;

  constructor(
    private readonly assetId: string = config.marketData.referenceAsset,
    private readonly baseUrl: string = config.marketData.coingeckoBaseUrl,
  ) {}

  async sample(): Promise<MarketSignals> {
    const url =
      `${this.baseUrl}/simple/price?ids=${encodeURIComponent(this.assetId)}` +
      `&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) throw new Error(`CoinGecko responded ${res.status}`);
      const body = (await res.json()) as Record<
        string,
        { usd?: number; usd_24h_vol?: number; usd_24h_change?: number }
      >;
      const entry = body[this.assetId];
      if (!entry?.usd) throw new Error(`no price for ${this.assetId}`);

      this.consecutiveFailures = 0;
      this.window.push(entry.usd);

      const volume = entry.usd_24h_vol ?? 0;
      if (this.lastVolume > 0 && volume > 0) {
        this.lastVolumeChangePct = ((volume - this.lastVolume) / this.lastVolume) * 100;
      }
      if (volume > 0) this.lastVolume = volume;

      return {
        volatilityPct: round(this.window.volatilityPct(), 3),
        priceDeviationPct: round(this.window.deviationPct(), 3),
        drawdownPct: round(this.window.drawdownPct(), 3),
        volumeChangePct: round(this.lastVolumeChangePct, 2),
        priceUsd: entry.usd,
        source: "live",
      };
    } catch (err) {
      this.consecutiveFailures++;
      logger.warn(
        { err, assetId: this.assetId, consecutiveFailures: this.consecutiveFailures },
        "market data fetch failed — reporting last known window as simulated",
      );
      // Degrade honestly: keep serving the pipeline, but stop claiming the
      // numbers are live.
      const last = this.window.latest() ?? 0;
      return {
        volatilityPct: round(this.window.volatilityPct(), 3),
        priceDeviationPct: round(this.window.deviationPct(), 3),
        drawdownPct: round(this.window.drawdownPct(), 3),
        volumeChangePct: 0,
        priceUsd: last,
        source: "simulated",
      };
    }
  }
}

/**
 * Deterministic-by-seed random walk. Used for offline development and for the
 * controlled demo path, where a reproducible baseline matters more than a real
 * feed. Always reports `source: "simulated"`.
 */
export class SimulatedMarketProvider implements MarketProvider {
  readonly kind = "simulated" as const;
  private readonly window = new PriceWindow();
  private price: number;
  private seed: number;

  constructor(startPrice = 1.0, seed = 0x5eed) {
    this.price = startPrice;
    this.seed = seed;
    // Prime the window so volatility is meaningful from the first sample.
    for (let i = 0; i < 30; i++) {
      this.price *= 1 + (this.random() - 0.5) * 0.004;
      this.window.push(this.price, Date.now() - (30 - i) * 60_000);
    }
  }

  /** xorshift32 — small, fast, and reproducible from the seed. */
  private random(): number {
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return (this.seed % 100_000) / 100_000;
  }

  async sample(): Promise<MarketSignals> {
    this.price *= 1 + (this.random() - 0.5) * 0.006;
    this.window.push(this.price);

    return {
      volatilityPct: round(this.window.volatilityPct(), 3),
      priceDeviationPct: round(this.window.deviationPct(), 3),
      drawdownPct: round(this.window.drawdownPct(), 3),
      volumeChangePct: round((this.random() - 0.5) * 40, 2),
      priceUsd: round(this.price, 6),
      source: "simulated",
    };
  }
}

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

export function createMarketProvider(): MarketProvider {
  if (config.marketData.provider === "coingecko") {
    logger.info({ asset: config.marketData.referenceAsset }, "using live market data");
    return new CoinGeckoProvider();
  }
  logger.info("using simulated market data");
  return new SimulatedMarketProvider();
}
