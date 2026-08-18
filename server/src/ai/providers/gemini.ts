import { GoogleGenAI } from "@google/genai";
import { config } from "../../config.js";
import type { AiProvider, StructuredRequest, StructuredResult } from "./types.js";

/**
 * Google Gemini provider.
 *
 * Uses the Interactions API with `response_format` so the model returns JSON
 * matching the caller's schema rather than prose. Gemini supports the subset
 * of JSON Schema this pipeline needs (type, properties, required, enum, items,
 * minItems/maxItems, description, additionalProperties), so the Analyst and
 * Guardian schemas are passed through unchanged.
 */
/**
 * Head-room added to every request's token ceiling to cover Gemini's internal
 * reasoning, which is billed against the same `max_output_tokens` budget as the
 * visible response.
 */
const THINKING_ALLOWANCE_TOKENS = 6_000;

export class GeminiProvider implements AiProvider {
  readonly name = "gemini";
  readonly model: string;
  readonly authMode = "x-goog-api-key (Google AI)";

  private client: GoogleGenAI;

  constructor(apiKey: string, model: string) {
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  /**
   * Maps the shared effort setting onto Gemini's thinking levels. Anthropic's
   * ladder is finer-grained, so the top three collapse to `high` rather than
   * inventing a level the API would reject.
   */
  private thinkingLevel(): "low" | "medium" | "high" {
    switch (config.ai.effort) {
      case "low":
        return "low";
      case "medium":
        return "medium";
      default:
        return "high";
    }
  }

  async generateStructured(request: StructuredRequest): Promise<StructuredResult> {
    try {
      const interaction = await this.client.interactions.create({
        model: this.model,
        input: request.prompt,
        system_instruction: request.system,
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: request.schema,
        },
        generation_config: {
          thinking_level: this.thinkingLevel(),
          // Reasoning tokens are drawn from this same budget on Gemini, so the
          // ceiling has to cover thinking *and* the JSON. Sized at the caller's
          // request plus a reasoning allowance: too tight and the model spends
          // the budget thinking, then emits a payload that stops mid-string —
          // which surfaces confusingly as a schema-validation failure.
          max_output_tokens: request.maxTokens + THINKING_ALLOWANCE_TOKENS,
        },
      } as Parameters<typeof this.client.interactions.create>[0]);

      const text = (interaction as { output_text?: string }).output_text;
      if (!text || text.trim().length === 0) {
        return {
          json: null,
          failure: {
            message:
              "response contained no text — the model may have been blocked or returned only reasoning",
          },
        };
      }

      return { json: text };
    } catch (err) {
      return { json: null, failure: describeGeminiError(err) };
    }
  }
}

interface GoogleErrorPayload {
  error?: { code?: number; message?: string; status?: string };
}

/**
 * Pulls a usable status and message out of a Google API error.
 *
 * The SDK's `message` is unhelpful — it renders as
 * `400 API error occurred: {"httpMeta":{...}}`. The real reason ("API key not
 * valid", "model not found", quota text) is in `body`, a JSON string holding
 * either an object or a single-element array. This reads that first and only
 * falls back to the SDK message.
 */
function describeGeminiError(err: unknown): { status?: number; message: string } {
  if (typeof err !== "object" || err === null) {
    return { message: String(err) };
  }
  const e = err as {
    status?: number;
    statusCode?: number;
    code?: number;
    message?: string;
    body?: unknown;
  };

  const status = e.status ?? e.statusCode ?? e.code;

  if (typeof e.body === "string") {
    try {
      const parsed = JSON.parse(e.body) as GoogleErrorPayload | GoogleErrorPayload[];
      const payload = Array.isArray(parsed) ? parsed[0] : parsed;
      const detail = payload?.error;
      if (detail?.message) {
        return {
          status: status ?? detail.code,
          message: detail.status ? `${detail.status}: ${detail.message}` : detail.message,
        };
      }
    } catch {
      // Body was not JSON — fall through to the SDK message.
    }
  }

  return { status, message: e.message ?? "request failed" };
}
