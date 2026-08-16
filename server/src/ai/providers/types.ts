/**
 * Provider-agnostic contract for the AI layer.
 *
 * The Analyst and Guardian only ever ask for "JSON matching this schema".
 * Keeping that the entire surface means swapping providers touches one file,
 * and a provider that cannot honour the schema fails cleanly into the
 * deterministic path rather than returning prose the pipeline would choke on.
 */

export interface StructuredRequest {
  /** Human label used in logs and diagnostics. */
  label: string;
  system: string;
  prompt: string;
  /** JSON Schema the response must satisfy. */
  schema: Record<string, unknown>;
  maxTokens: number;
}

export interface ProviderFailure {
  status?: number;
  message: string;
}

export interface StructuredResult {
  /** Raw JSON text from the model, or null when the call failed. */
  json: string | null;
  failure?: ProviderFailure;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AiProvider {
  readonly name: string;
  /** Model identifier in use, for diagnostics. */
  readonly model: string;
  /** How the provider authenticates, for diagnostics. */
  readonly authMode: string;
  generateStructured(request: StructuredRequest): Promise<StructuredResult>;
}
