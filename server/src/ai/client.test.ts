import { afterEach, describe, expect, it, vi } from "vitest";
import { callStructured, getLastAiError, setProvider } from "./client.js";
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
