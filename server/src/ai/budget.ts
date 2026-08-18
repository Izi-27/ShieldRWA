import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Global request budget for the AI layer.
 *
 * Per-position gating is not enough: the pipeline runs every active position
 * each cycle, so N positions multiply whatever any single position was allowed.
 * This is a process-wide token bucket sized to the provider's quota.
 *
 * When the budget is exhausted the call is *skipped*, not queued and not
 * retried. A skipped call falls back to the deterministic Analyst or Guardian,
 * which is a complete and correct result — whereas a queued call would stall
 * the risk cycle, and a retried one would keep hammering a provider that has
 * already said no.
 */

interface BucketState {
  /** Timestamps of requests inside the current window. */
  recent: number[];
  skipped: number;
  lastWarnAt: number;
  /** Set when the provider itself rate-limits us; no calls until it passes. */
  cooldownUntil: number;
}

const state: BucketState = { recent: [], skipped: 0, lastWarnAt: 0, cooldownUntil: 0 };

/**
 * Records a provider-side rate limit.
 *
 * The local bucket is only an estimate of the provider's quota — it cannot see
 * usage from other clients sharing the key, or a daily cap, or a window that
 * started before this process did. When the provider says no, that is
 * authoritative: stop calling until the time it names, instead of continuing to
 * spend requests that are certain to be rejected.
 */
export function recordRateLimit(retryAfterSeconds: number | null): void {
  const waitMs = Math.min(
    5 * 60_000,
    Math.max(WINDOW_MS, (retryAfterSeconds ?? 60) * 1_000),
  );
  state.cooldownUntil = Date.now() + waitMs;
  logger.warn(
    { retryInSeconds: Math.ceil(waitMs / 1_000) },
    "provider rate-limited us — pausing AI calls",
  );
}

/** Parses the retry hint out of a provider's rate-limit message. */
export function parseRetryAfterSeconds(message: string): number | null {
  const match = /retry in ([\d.]+)\s*s/i.exec(message);
  const seconds = match?.[1] ? Number.parseFloat(match[1]) : NaN;
  return Number.isFinite(seconds) ? Math.ceil(seconds) : null;
}

const WINDOW_MS = 60_000;

/**
 * Reserves one request slot.
 * @returns true when the caller may proceed, false when it must fall back.
 */
export function tryReserve(label: string): boolean {
  const now = Date.now();

  // A provider-imposed cooldown outranks the local estimate.
  if (now < state.cooldownUntil) {
    state.skipped++;
    return false;
  }

  const limit = config.ai.maxRpm;
  if (limit <= 0) return true; // 0 disables the budget entirely.
  const cutoff = now - WINDOW_MS;
  // Drop timestamps that have aged out of the window.
  while (state.recent.length > 0 && state.recent[0]! < cutoff) state.recent.shift();

  if (state.recent.length >= limit) {
    state.skipped++;
    // One warning per window, not one per skip — otherwise a busy pipeline
    // floods the log with the same message.
    if (now - state.lastWarnAt > WINDOW_MS) {
      state.lastWarnAt = now;
      const retryInMs = Math.max(0, (state.recent[0] ?? now) + WINDOW_MS - now);
      logger.warn(
        {
          label,
          limit,
          skippedSinceLastWarning: state.skipped,
          retryInSeconds: Math.ceil(retryInMs / 1_000),
        },
        "AI request budget exhausted — using deterministic path",
      );
      state.skipped = 0;
    }
    return false;
  }

  state.recent.push(now);
  return true;
}

/** Current budget usage, for diagnostics and /api/health. */
export function budgetStatus(): {
  limitPerMinute: number;
  usedInWindow: number;
  remaining: number;
  cooldownSeconds: number;
} {
  const limit = config.ai.maxRpm;
  const cutoff = Date.now() - WINDOW_MS;
  const used = state.recent.filter((t) => t >= cutoff).length;
  return {
    limitPerMinute: limit,
    usedInWindow: used,
    remaining: limit <= 0 ? Number.POSITIVE_INFINITY : Math.max(0, limit - used),
    cooldownSeconds: Math.max(0, Math.ceil((state.cooldownUntil - Date.now()) / 1_000)),
  };
}

/** Test seam. */
export function resetBudget(): void {
  state.recent = [];
  state.skipped = 0;
  state.lastWarnAt = 0;
  state.cooldownUntil = 0;
}
