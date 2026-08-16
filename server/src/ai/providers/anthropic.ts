import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config.js";
import type { AiProvider, StructuredRequest, StructuredResult } from "./types.js";

/**
 * Anthropic provider.
 *
 * Kept alongside Gemini so the deployment can switch back with one env var —
 * useful when a gateway turns out not to allow programmatic access, or when a
 * direct key becomes available.
 *
 * The endpoint must speak the Messages API and pass `thinking` and
 * `output_config` through untouched. A gateway that strips
 * `output_config.format` returns prose, JSON parsing fails, and the pipeline
 * falls back to deterministic — safe, but the model stops contributing.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  readonly model: string;
  readonly authMode: string;

  private client: Anthropic;

  constructor(options: {
    apiKey?: string;
    authToken?: string;
    baseUrl?: string;
    model: string;
    timeoutMs: number;
  }) {
    this.model = options.model;
    this.authMode = options.authToken
      ? "Authorization: Bearer (gateway)"
      : "x-api-key (Anthropic direct)";

    this.client = new Anthropic({
      // Exactly one credential: `apiKey` becomes `x-api-key`, `authToken`
      // becomes `Authorization: Bearer`. Sending both is a 401, which config
      // rejects at boot.
      ...(options.authToken
        ? { authToken: options.authToken, apiKey: null }
        : { apiKey: options.apiKey }),
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      timeout: options.timeoutMs,
      maxRetries: 2,
    });
  }

  async generateStructured(request: StructuredRequest): Promise<StructuredResult> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens,
        // Adaptive thinking: the model decides how much reasoning each
        // assessment warrants. Depth is tuned with `effort`, not a budget.
        thinking: { type: "adaptive" },
        output_config: {
          effort: config.ai.effort,
          format: { type: "json_schema", schema: request.schema },
        },
        system: request.system,
        messages: [{ role: "user", content: request.prompt }],
      });

      if (response.stop_reason === "refusal") {
        return { json: null, failure: { message: "model declined the request" } };
      }
      if (response.stop_reason === "max_tokens") {
        return { json: null, failure: { message: "response truncated at max_tokens" } };
      }

      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        return { json: null, failure: { message: "response contained no text block" } };
      }

      return {
        json: textBlock.text,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (err) {
      return { json: null, failure: describeAnthropicError(err) };
    }
  }
}

/** Pulls the useful message out of an SDK error, including nested gateway bodies. */
function describeAnthropicError(err: unknown): { status?: number; message: string } {
  if (typeof err !== "object" || err === null) {
    return { message: String(err) };
  }
  const e = err as {
    status?: number;
    message?: string;
    error?: { error?: { message?: string }; message?: string };
  };
  // Gateways commonly nest the real reason two levels down.
  const nested = e.error?.error?.message ?? e.error?.message;
  return {
    status: e.status,
    message: nested
      ? `${e.message ?? "request failed"} — ${nested}`
      : (e.message ?? "request failed"),
  };
}
