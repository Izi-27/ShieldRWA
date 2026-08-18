import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callStructured, getLastAiError, setProvider } from "./client.js";
import { budgetStatus, resetBudget } from "./budget.js";
import type { AiProvider, StructuredResult } from "./providers/types.js";
import { z } from "zod";

/**
 * The provider seam is what makes swapping Gemini for Anthropic a config
 * change. These tests pin the contract every provider must satisfy: valid JSON
 * through, anything else null — never a half-parsed object reaching the
 * pipeline.
 */

const Schema = z.object({ action: z.enum(["HOLD", "REDUCE"]), size: z.number().min(0).max(100) });

function stubProvider(result: StructuredResult): AiProvider {
  return {
    name: "stub",
    model: "stub-model",
    authMode: "none",
    generateStructured: vi.fn(async () => result),
  };
}

function call() {
  return callStructured({
    label: "test",
    system: "system",
    prompt: "prompt",
    schema: { type: "object" },
    validate: (value) => Schema.parse(value),
  });
}

// The request budget is process-wide by design, so it must be cleared
// between tests or later cases inherit an exhausted bucket.
beforeEach(() => resetBudget());
afterEach(() => setProvider(null));

describe("callStructured", () => {
  it("returns the parsed value when the provider honours the schema", async () => {
    setProvider(stubProvider({ json: '{"action":"REDUCE","size":35}' }));
    await expect(call()).resolves.toEqual({ action: "REDUCE", size: 35 });
  });

  it("returns null when no provider is configured", async () => {
    setProvider(null);
    await expect(call()).resolves.toBeNull();
  });

  it("returns null and records the reason when the provider errors", async () => {
    setProvider(
      stubProvider({ json: null, failure: { status: 401, message: "unauthorized client detected" } }),
    );

    await expect(call()).resolves.toBeNull();
    const failure = getLastAiError();
    expect(failure?.status).toBe(401);
    expect(failure?.message).toContain("unauthorized client");
    expect(failure?.label).toBe("test");
  });

  it("returns null when the provider ignores the schema and returns prose", async () => {
    setProvider(stubProvider({ json: "Based on the signals, I recommend reducing exposure." }));

    await expect(call()).resolves.toBeNull();
    expect(getLastAiError()?.message).toMatch(/did not match the requested schema/i);
  });

  it("returns null when the JSON is well-formed but violates the schema", async () => {
    // The dangerous case: parseable, so a naive implementation would pass this
    // straight into the pipeline.
    setProvider(stubProvider({ json: '{"action":"LIQUIDATE_EVERYTHING","size":9999}' }));

    await expect(call()).resolves.toBeNull();
    expect(getLastAiError()?.message).toMatch(/did not match the requested schema/i);
  });

  it("returns null when the provider returns empty output", async () => {
    setProvider(stubProvider({ json: null, failure: { message: "response contained no text" } }));
    await expect(call()).resolves.toBeNull();
    expect(getLastAiError()?.message).toContain("no text");
  });
});

describe("request budget", () => {
  it("stops calling the provider once the per-minute ceiling is reached", async () => {
    const provider = stubProvider({ json: '{"action":"HOLD","size":0}' });
    setProvider(provider);

    const limit = budgetStatus().limitPerMinute;
    expect(limit).toBeGreaterThan(0);

    // Spend the whole budget.
    for (let i = 0; i < limit; i++) {
      await expect(call()).resolves.toEqual({ action: "HOLD", size: 0 });
    }
    expect(budgetStatus().remaining).toBe(0);

    // The next call must never reach the provider — that is the entire point:
    // a 429 costs latency and still ends in the deterministic fallback.
    const callsBefore = (provider.generateStructured as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(call()).resolves.toBeNull();
    const callsAfter = (provider.generateStructured as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(callsAfter).toBe(callsBefore);
  });

  it("reports usage so /api/health can surface remaining headroom", async () => {
    setProvider(stubProvider({ json: '{"action":"HOLD","size":0}' }));
    const before = budgetStatus();
    await call();
    const after = budgetStatus();

    expect(after.usedInWindow).toBe(before.usedInWindow + 1);
    expect(after.remaining).toBe(before.remaining - 1);
  });
});

describe("truncation versus schema mismatch", () => {
  it("reports a cut-off JSON payload as truncation, not a schema failure", async () => {
    // Exactly what Gemini returned when reasoning tokens ate the output budget.
    setProvider(
      stubProvider({
        json: '{\n  "action": "REDUCE",\n  "size": 34,\n  "why": "the investor',
      }),
    );

    await expect(call()).resolves.toBeNull();
    expect(getLastAiError()?.message).toMatch(/cut off before the JSON closed/i);
  });

  it("still reports prose as a schema mismatch", async () => {
    // Prose also fails to end in "}", so the check must look at the start too.
    setProvider(stubProvider({ json: "I recommend reducing exposure by about a third." }));

    await expect(call()).resolves.toBeNull();
    expect(getLastAiError()?.message).toMatch(/did not match the requested schema/i);
  });
});
