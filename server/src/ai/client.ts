import { config } from "../config.js";
import { logger } from "../logger.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { GeminiProvider } from "./providers/gemini.js";
import type { AiProvider, ProviderFailure } from "./providers/types.js";

/**
 * Provider-agnostic entry point for the AI layer.
 *
 * Every AI call in this service is structured-output only — we ask for JSON
 * matching a schema and validate it, so a malformed, refused or truncated
 * response is a clean failure the caller falls back from rather than free text
 * we would have to guess at.
 *
 * `available` is false when no provider is configured; callers then use their
 * deterministic implementation and label the output `source: "deterministic"`.
 */

let provider: AiProvider | null = null;
let resolved = false;

export function getProvider(): AiProvider | null {
  if (resolved) return provider;
  resolved = true;

  if (!config.ai.enabled) {
    provider = null;
    return provider;
  }

  if (config.ai.provider === "gemini") {
    provider = new GeminiProvider(config.ai.geminiApiKey!, config.ai.model);
  } else {
    provider = new AnthropicProvider({
      apiKey: config.ai.apiKey,
      authToken: config.ai.authToken,
      baseUrl: config.ai.baseUrl,
      model: config.ai.model,
      timeoutMs: config.ai.timeoutMs,
    });
  }

  logger.info(
    { provider: provider.name, model: provider.model, auth: provider.authMode },
    "AI provider ready",
  );
  return provider;
}

/** Test seam — lets suites install a stub without touching the network. */
export function setProvider(next: AiProvider | null): void {
  provider = next;
  resolved = true;
}

export const aiAvailable = (): boolean => config.ai.enabled;

/**
 * Why the most recent AI call failed.
 *
 * `callStructured` deliberately swallows failures so the pipeline can fall
 * back, which means the underlying reason is otherwise only visible in debug
 * logs. Diagnostics — `npm run verify:ai` — read this to report the actual
 * upstream error instead of guessing.
 */
let lastError: (ProviderFailure & { label: string; at: number }) | null = null;

export function getLastAiError(): typeof lastError {
  return lastError;
}

export interface StructuredCallOptions<T> {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  /** Human label used in logs and metrics. */
  label: string;
  validate: (value: unknown) => T;
  maxTokens?: number;
}

/**
 * Runs one structured-output call and validates the result.
 *
 * Returns null on any failure — transport, refusal, truncation or schema
 * mismatch — so callers always have a single well-defined fallback path.
 */
export async function callStructured<T>(opts: StructuredCallOptions<T>): Promise<T | null> {
  const active = getProvider();
  if (!active) return null;

  const started = Date.now();
  const result = await active.generateStructured({
    label: opts.label,
    system: opts.system,
    prompt: opts.prompt,
    schema: opts.schema,
    maxTokens: opts.maxTokens ?? 4_000,
  });

  if (!result.json) {
    lastError = {
      label: opts.label,
      at: Date.now(),
      ...(result.failure ?? { message: "provider returned no output" }),
    };
    logger.warn(
      { label: opts.label, provider: active.name, failure: result.failure, ms: Date.now() - started },
      "AI call failed",
    );
    return null;
  }

  try {
    const validated = opts.validate(JSON.parse(result.json) as unknown);
    logger.debug(
      {
        label: opts.label,
        provider: active.name,
        ms: Date.now() - started,
        usage: result.usage,
      },
      "AI call complete",
    );
    return validated;
  } catch (err) {
    // The call succeeded but the payload did not match the schema — most often
    // a provider that ignored the response format and returned prose.
    lastError = {
      label: opts.label,
      at: Date.now(),
      message: `response did not match the requested schema: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
    logger.warn(
      { err, label: opts.label, provider: active.name, sample: result.json.slice(0, 200) },
      "AI response failed schema validation",
    );
    return null;
  }
}
