import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoinGeckoProvider } from "./market.js";

/**
 * The feed's job when CoinGecko says no is to stop asking. A rate limiter that
 * keeps being hit extends its own penalty, so these tests pin the two things
 * that keep the service off the naughty list: the key goes out on every
 * request, and a rejection buys silence for as long as it asked for.
 */

const ASSET = "ethereum";
const BASE = "https://api.example.test/api/v3";

function priceResponse(usd: number): Response {
  return new Response(JSON.stringify({ [ASSET]: { usd, usd_24h_vol: 1_000 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function rateLimited(retryAfter?: string): Response {
  return new Response("rate limited", {
    status: 429,
    headers: retryAfter ? { "retry-after": retryAfter } : {},
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CoinGeckoProvider", () => {
  it("sends the demo key header when a key is configured", async () => {
    fetchMock.mockResolvedValue(priceResponse(3_000));
    const provider = new CoinGeckoProvider(ASSET, BASE, "cg-demo-key");

    await provider.sample();

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers).toEqual({ "x-cg-demo-api-key": "cg-demo-key" });
  });

  it("omits the header entirely when no key is configured", async () => {
    fetchMock.mockResolvedValue(priceResponse(3_000));
    const provider = new CoinGeckoProvider(ASSET, BASE, undefined);

    await provider.sample();

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers).toEqual({});
  });

  it("stops calling upstream while backing off from a 429", async () => {
    fetchMock.mockResolvedValue(rateLimited());
    const provider = new CoinGeckoProvider(ASSET, BASE, undefined);

    const first = await provider.sample();
    expect(first.source).toBe("simulated");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call lands inside the backoff window: served locally, no request.
    const second = await provider.sample();
    expect(second.source).toBe("simulated");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honours a Retry-After header over its own backoff", async () => {
    fetchMock.mockResolvedValue(rateLimited("120"));
    const provider = new CoinGeckoProvider(ASSET, BASE, undefined);
    await provider.sample();

    // The default first backoff is 15s. The server asked for 120s, so at 60s
    // in we must still be quiet.
    vi.advanceTimersByTime(60_000);
    await provider.sample();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    await provider.sample();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("widens the gap between attempts as failures accumulate", async () => {
    fetchMock.mockResolvedValue(rateLimited());
    const provider = new CoinGeckoProvider(ASSET, BASE, undefined);

    await provider.sample(); // failure 1 → 15s
    vi.advanceTimersByTime(15_001);
    await provider.sample(); // failure 2 → 30s
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 20s is past the first delay but short of the second.
    vi.advanceTimersByTime(20_000);
    await provider.sample();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(11_000);
    await provider.sample();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("resumes normal cadence once a request succeeds", async () => {
    fetchMock.mockResolvedValueOnce(rateLimited());
    const provider = new CoinGeckoProvider(ASSET, BASE, undefined);
    await provider.sample();

    fetchMock.mockResolvedValue(priceResponse(3_100));
    vi.advanceTimersByTime(15_001);
    expect((await provider.sample()).source).toBe("live");

    // Backoff is cleared, so the very next call goes straight out.
    await provider.sample();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
