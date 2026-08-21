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

/** Upstream rejection that carries the server's own retry hint, when it gave one. */
class UpstreamError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

/** Shortest and longest we will wait between attempts once the feed starts failing. */
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_CAP_MS = 300_000;

/** Reads a real price series from the CoinGecko public API. */
export class CoinGeckoProvider implements MarketProvider {
  readonly kind = "live" as const;
  private readonly window = new PriceWindow();
  private lastVolume = 0;
  private lastVolumeChangePct = 0;
  private consecutiveFailures = 0;
  /** Epoch ms before which `sample` must not touch the network. */
  private nextAttemptAt = 0;

  constructor(
    private readonly assetId: string = config.marketData.referenceAsset,
    private readonly baseUrl: string = config.marketData.coingeckoBaseUrl,
    private readonly apiKey: string | undefined = config.marketData.coingeckoApiKey,
  ) {}

  /**
   * Last known window, reported honestly as simulated. Used both when a fetch
   * fails and while we are backing off from one that did.
   */
  private degraded(): MarketSignals {
    return {
      volatilityPct: round(this.window.volatilityPct(), 3),
      priceDeviationPct: round(this.window.deviationPct(), 3),
      drawdownPct: round(this.window.drawdownPct(), 3),
      volumeChangePct: 0,
      priceUsd: this.window.latest() ?? 0,
      source: "simulated",
    };
  }

  async sample(): Promise<MarketSignals> {
    const url =
      `${this.baseUrl}/simple/price?ids=${encodeURIComponent(this.assetId)}` +
      `&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`;

    // While backing off, serve the last window without touching the network.
    // Hammering a rate limiter is what extends its penalty.
    if (Date.now() < this.nextAttemptAt) return this.degraded();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      const res = await fetch(url, {
        signal: controller.signal,
        // Sent only on the demo plan's own host; the pro host expects a
        // different header name, so a key is not forwarded blindly.
        headers: this.apiKey ? { "x-cg-demo-api-key": this.apiKey } : {},
      });
      clearTimeout(timer);

      if (!res.ok) {
        // 429 and 5xx often carry Retry-After. Honour it over our own guess.
        const header = res.headers.get("retry-after");
        const seconds = header ? Number(header) : NaN;
        throw new UpstreamError(
          `CoinGecko responded ${res.status}`,
          Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined,
        );
      }
      const body = (await res.json()) as Record<
        string,
        { usd?: number; usd_24h_vol?: number; usd_24h_change?: number }
      >;
      const entry = body[this.assetId];
      if (!entry?.usd) throw new Error(`no price for ${this.assetId}`);

      this.consecutiveFailures = 0;
      this.nextAttemptAt = 0;
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

      // Exponential from the first failure, capped, unless the server told us
      // exactly how long to wait.
      const hinted = err instanceof UpstreamError ? err.retryAfterMs : undefined;
      const backoffMs =
        hinted ??
        Math.min(BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1), BACKOFF_CAP_MS);
      this.nextAttemptAt = Date.now() + backoffMs;

      logger.warn(
        {
          err,
          assetId: this.assetId,
          consecutiveFailures: this.consecutiveFailures,
          retryInMs: backoffMs,
          hintedByServer: hinted !== undefined,
          hasApiKey: this.apiKey !== undefined,
        },
        "market data fetch failed — reporting last known window as simulated",
      );
      // Degrade honestly: keep serving the pipeline, but stop claiming the
      // numbers are live.
      return this.degraded();
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

/**
 * Serves one upstream sample to every caller inside a short window.
 *
 * The pipeline samples once per position per cycle: at a 5s cycle with two
 * positions that is 24 requests a minute to a public price API, which will be
 * rate-limited well before it is useful. Prices do not move meaningfully
 * between cycles, and every position references the same asset, so one read
 * serves them all.
 *
 * Concurrent callers share the in-flight request rather than each starting one.
 */
export class CachedMarketProvider implements MarketProvider {
  readonly kind: "live" | "simulated";

  private cached: { at: number; value: MarketSignals } | null = null;
  private inFlight: Promise<MarketSignals> | null = null;

  constructor(
    private readonly inner: MarketProvider,
    private readonly ttlMs: number,
  ) {
    this.kind = inner.kind;
  }

  async sample(): Promise<MarketSignals> {
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) {
      return this.cached.value;
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.inner
      .sample()
      .then((value) => {
        this.cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }
}

export function createMarketProvider(): MarketProvider {
  const ttl = config.marketData.cacheMs;

  if (config.marketData.provider === "coingecko") {
    logger.info(
      {
        asset: config.marketData.referenceAsset,
        cacheMs: ttl,
        hasApiKey: config.marketData.coingeckoApiKey !== undefined,
      },
      "using live market data",
    );
    return new CachedMarketProvider(new CoinGeckoProvider(), ttl);
  }

  logger.info("using simulated market data");
  // The simulator is free to call, but caching it too keeps the sampling
  // cadence identical between providers so behaviour does not change with the
  // configuration.
  return new CachedMarketProvider(new SimulatedMarketProvider(), ttl);
}
