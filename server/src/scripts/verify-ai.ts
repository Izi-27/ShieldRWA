import { config } from "../config.js";
import { getLastAiError, getProvider } from "../ai/client.js";
import { analyse } from "../ai/analyst.js";
import { decide } from "../ai/guardian.js";
import type { ProtectionPolicy, SignalSnapshot } from "../domain/types.js";

/**
 * Checks that the configured AI provider can actually drive the pipeline.
 *
 * Accepting a request is not enough: the provider has to return schema-valid
 * JSON, or the Analyst and Guardian silently degrade to their deterministic
 * implementations. That degradation is safe but invisible from the dashboard,
 * which is exactly why it is worth checking explicitly before deploying.
 *
 * Run with: npm run verify:ai
 */

const STRESSED: SignalSnapshot = {
  positionId: "pos_verify",
  capturedAt: Date.now(),
  market: {
    volatilityPct: 9.2,
    priceDeviationPct: 4.1,
    drawdownPct: 12,
    volumeChangePct: 64,
    priceUsd: 1,
    source: "live",
  },
  asset: {
    issuerEventActive: true,
    issuerEventSeverity: 0.85,
    daysToNextRepayment: 3,
    description: "Repayment delay flagged on RWA-T3",
  },
  onchain: {
    oracleDeviationSigma: 2.4,
    liquidityDepthUsd: 420_000,
    depthChangePct: -38,
    poolImbalance: 0.62,
    oracleStalenessSeconds: 45,
  },
  portfolio: {
    concentration: 0.61,
    correlatedExposure: 0.55,
    positionDrawdownPct: 4.6,
    defensiveShare: 0,
  },
};

const POLICY: ProtectionPolicy = {
  positionId: "pos_verify",
  posture: "Balanced",
  maxDrawdownBps: 1_000,
  maxExposureBps: 4_000,
  minLiquidityUsd: 250_000,
  defensiveAsset: "USDC",
  mode: "MANUAL",
  updatedAt: Date.now(),
};

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function main(): Promise<void> {
  console.log("\nShieldRWA — AI provider verification\n");

  const active = getProvider();
  line("Provider", config.ai.provider);
  line("Model", config.ai.model);
  line("Effort", config.ai.effort);
  line("Auth mode", active?.authMode ?? "none");
  if (config.ai.provider === "anthropic" && config.ai.baseUrl) {
    line("Endpoint", config.ai.baseUrl);
  }

  if (!config.ai.enabled) {
    const needed =
      config.ai.provider === "gemini"
        ? "GEMINI_API_KEY"
        : "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN";
    console.log(`\n✗ ${needed} is not set for AI_PROVIDER=${config.ai.provider}.\n`);
    process.exit(1);
  }

  console.log("\n[1/2] AI Risk Analyst");
  const startedAnalyst = Date.now();
  const assessment = await analyse({ snapshot: STRESSED, positionValueUsd: 10_000 });
  const analystMs = Date.now() - startedAnalyst;

  line("Source", assessment.source);
  line("Latency", `${analystMs}ms`);
  line("Composite score", assessment.compositeScore.toFixed(1));
  line("Recommended", assessment.recommendedAction);
  line("Factors returned", String(assessment.factors.length));
  console.log(`\n  Reasoning:\n    ${wrap(assessment.reasoning, 74)}\n`);

  console.log("[2/2] AI Risk Guardian");
  const startedGuardian = Date.now();
  const decision = await decide({
    assessment,
    policy: POLICY,
    snapshot: STRESSED,
    positionValueUsd: 10_000,
  });
  const guardianMs = Date.now() - startedGuardian;

  line("Source", decision.source);
  line("Latency", `${guardianMs}ms`);
  line("Analyst proposed", decision.proposedAction);
  line("Guardian decided", decision.finalAction);
  line("Rotation", `${(decision.rotationBps / 100).toFixed(0)}%`);
  line("Policy verdict", decision.policyMatch);
  console.log(`\n  Rationale:\n    ${wrap(decision.rationale, 74)}\n`);

  if (assessment.source === "ai" && decision.source === "ai") {
    console.log(`✓ Both AI stages returned live, schema-valid output via ${config.ai.provider}.`);
    console.log("  Structured output and reasoning config are being honoured.\n");
    process.exit(0);
  }

  console.log("✗ One or both stages fell back to the deterministic path.");
  console.log("  The app still works correctly, but the model is not contributing.\n");

  const failure = getLastAiError();
  if (failure) {
    console.log("  Upstream said:");
    console.log(`    ${failure.status ?? "no status"} — ${failure.message}\n`);
    console.log(`  ${interpret(failure.status, failure.message)}\n`);
  } else {
    console.log("  No failure was recorded, which should not happen — re-run with");
    console.log("  LOG_LEVEL=debug for the raw provider response.\n");
  }
  process.exit(1);
}

/** Turns an upstream failure into the specific thing to do about it. */
function interpret(status: number | undefined, message: string): string {
  const m = message.toLowerCase();

  if (status === 401 && m.includes("client")) {
    return [
      "The credential authenticated but the provider rejected this CLIENT.",
      "  Gateways aimed at coding tools often allow only those tools, not general",
      "  API traffic. Use a provider that permits programmatic access.",
    ].join("\n");
  }
  if (m.includes("api key not valid") || m.includes("api_key_invalid")) {
    return [
      "The API key was rejected. For Gemini, create one at",
      "  https://aistudio.google.com/apikey and set GEMINI_API_KEY.",
    ].join("\n");
  }
  if (status === 401 || status === 403) {
    return [
      "Credential rejected. Check the key belongs to the selected provider and",
      "  that the API is enabled for it.",
    ].join("\n");
  }
  if (status === 404) {
    return [
      "Endpoint or model not found. Confirm the model id above exists on this",
      "  provider — model names change, and retired ids 404 rather than warn.",
    ].join("\n");
  }
  if (status === 400 && (m.includes("schema") || m.includes("response_format"))) {
    return [
      "The provider rejected the response schema. It must accept the JSON Schema",
      "  subset the Analyst and Guardian use (type, properties, required, enum,",
      "  items, description).",
    ].join("\n");
  }
  if (m.includes("did not match the requested schema")) {
    return [
      "The call succeeded but the payload was not schema-valid JSON — the provider",
      "  is most likely ignoring the structured-output setting and returning prose.",
    ].join("\n");
  }
  if (status === 429) {
    return "Rate limited or out of quota. Retry, or raise the provider's limits.";
  }
  if (status === undefined) {
    return "No HTTP status — likely a network, DNS or TLS failure reaching the provider.";
  }
  return "Check the provider's documentation for this status.";
}

function wrap(text: string, width: number): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > width) {
      lines.push(current.trim());
      current = word;
    } else {
      current += " " + word;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines.join("\n    ");
}

main().catch((err) => {
  console.error("\n✗ Verification failed with an error:\n", err);
  process.exit(1);
});
