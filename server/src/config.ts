import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

// Tests must not inherit a developer's .env. Loading it made the suite depend
// on local machine state: once a real CHAIN_RPC_URL and a deployment address
// book existed, the API tests started exercising a live-chain code path they
// were written to avoid, and failed. Test runs configure themselves entirely
// through process.env.
if (process.env.NODE_ENV !== "test") {
  dotenv.config();
}

/**
 * All runtime configuration, validated once at boot. Anything the server can
 * run without (chain, AI key) is optional and degrades to a documented
 * fallback rather than throwing — see `chainEnabled` / `aiEnabled`.
 */

const hexAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "expected a 20-byte hex address");
const hexKey = z.string().regex(/^0x[a-fA-F0-9]{64}$/, "expected a 32-byte hex private key");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  DATABASE_PATH: z.string().default("./data/shieldrwa.db"),

  JWT_SECRET: z.string().min(32).default("dev-only-insecure-secret-change-me-in-production!!"),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 12),
  SIWE_NONCE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // --- chain ---
  CHAIN_RPC_URL: z.string().url().optional(),
  CHAIN_ID: z.coerce.number().int().positive().default(1952),
  CHAIN_NAME: z.string().default("X Layer Testnet"),
  CHAIN_EXPLORER_URL: z.string().default("https://www.okx.com/web3/explorer/xlayer-test"),
  DEPLOYMENT_FILE: z.string().default("../contracts/deployments/xlayerTestnet.json"),
  GUARDIAN_PRIVATE_KEY: hexKey.optional(),
  RWA_POSITION_ADDRESS: hexAddress.optional(),
  RISK_ORACLE_ADDRESS: hexAddress.optional(),
  PROTECTION_EXECUTOR_ADDRESS: hexAddress.optional(),
  DEX_ROUTER_ADDRESS: hexAddress.optional(),
  RWA_TOKEN_ADDRESS: hexAddress.optional(),
  DEFENSIVE_TOKEN_ADDRESS: hexAddress.optional(),

  // --- AI ---
  // Which provider drives the Analyst and Guardian. Either can be swapped in
  // without touching the pipeline; both fall back to deterministic on failure.
  AI_PROVIDER: z.enum(["gemini", "anthropic"]).default("gemini"),

  // Google Gemini.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),

  // Anthropic direct: sent as the `x-api-key` header.
  ANTHROPIC_API_KEY: z.string().optional(),
  // Gateways that authenticate with `Authorization: Bearer` (unified-key
  // routers) use this instead. Setting both is rejected at boot: the SDK would
  // send both headers and the upstream would 401.
  ANTHROPIC_AUTH_TOKEN: z.string().optional(),
  // Point at an Anthropic-compatible gateway (a unified-key router, a proxy,
  // an internal egress host). Must speak the Messages API — see the note in
  // ai/providers/anthropic.ts about what the pipeline requires.
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5"),

  AI_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),

  // The risk score is deterministic and recomputed every cycle for free. The
  // model is only worth calling when it would actually say something new, so
  // narration is throttled to this interval and to material changes. Without
  // this the pipeline issues ~24 requests/minute, which exhausts every free
  // tier within a minute and costs real money on a paid one.
  AI_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(90_000),
  // Composite-score movement (0-100) that counts as material enough to
  // re-narrate before the interval elapses.
  AI_CHANGE_THRESHOLD: z.coerce.number().nonnegative().default(8),
  // Hard process-wide ceiling on AI requests per minute, sized to the
  // provider quota. Per-position gating cannot bound this on its own: every
  // active position runs each cycle, so N positions multiply through it.
  // Exceeding the quota costs a 429 and the deterministic fallback anyway,
  // so the budget skips instead. Set 0 to disable.
  AI_MAX_RPM: z.coerce.number().int().nonnegative().default(4),

  // --- market data ---
  MARKET_DATA_PROVIDER: z.enum(["coingecko", "simulated"]).default("simulated"),
  COINGECKO_BASE_URL: z.string().url().default("https://api.coingecko.com/api/v3"),
  MARKET_REFERENCE_ASSET: z.string().default("ethereum"),
  // One upstream price read is shared across positions for this long. The
  // pipeline samples per position per cycle, which without this would exceed
  // the free CoinGecko rate limit within a minute.
  MARKET_CACHE_MS: z.coerce.number().int().nonnegative().default(20_000),

  // --- risk pipeline ---
  RISK_CYCLE_MS: z.coerce.number().int().positive().default(5_000),
  RISK_ANCHOR_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  PREDICTION_HORIZON_HOURS: z.coerce.number().int().positive().default(6),
});

export type RawConfig = z.infer<typeof schema>;

function loadDeploymentBook(deploymentFile: string) {
  const resolved = path.isAbsolute(deploymentFile)
    ? deploymentFile
    : path.resolve(process.cwd(), deploymentFile);
  if (!fs.existsSync(resolved)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
    return parsed as {
      chainId?: number;
      guardian?: string;
      contracts?: Record<string, string>;
    };
  } catch {
    return null;
  }
}

function build() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;

  // Explicit env vars win; the deployment address book fills the gaps. Skipped
  // under test for the same reason as .env — a real deployment on disk must not
  // change what the suite exercises.
  const book = env.NODE_ENV === "test" ? null : loadDeploymentBook(env.DEPLOYMENT_FILE);
  const fromBook = book?.contracts ?? {};

  const contracts = {
    rwaPosition: env.RWA_POSITION_ADDRESS ?? fromBook.rwaPosition,
    riskOracle: env.RISK_ORACLE_ADDRESS ?? fromBook.riskOracle,
    protectionExecutor: env.PROTECTION_EXECUTOR_ADDRESS ?? fromBook.protectionExecutor,
    dexRouter: env.DEX_ROUTER_ADDRESS ?? fromBook.dexRouter,
    rwaToken: env.RWA_TOKEN_ADDRESS ?? fromBook.rwaToken,
    defensiveToken: env.DEFENSIVE_TOKEN_ADDRESS ?? fromBook.defensiveToken,
  };

  const chainEnabled = Boolean(
    env.CHAIN_RPC_URL &&
      contracts.rwaPosition &&
      contracts.riskOracle &&
      contracts.protectionExecutor,
  );

  const canSign = Boolean(chainEnabled && env.GUARDIAN_PRIVATE_KEY);

  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error(
      "Set either ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN, not both — " +
        "the SDK would send both credentials and the upstream would reject the request.",
    );
  }

  if (env.AI_PROVIDER === "gemini" && !env.GEMINI_API_KEY && env.ANTHROPIC_API_KEY) {
    // A silent fallback here would be worse than a warning: the operator would
    // believe Gemini is running while the app quietly used no model at all.
    console.warn(
      "[config] AI_PROVIDER=gemini but GEMINI_API_KEY is unset. " +
        "An ANTHROPIC_API_KEY is present but will not be used. " +
        "The Analyst and Guardian will run their deterministic implementations.",
    );
  }

  if (env.NODE_ENV === "production") {
    if (env.JWT_SECRET.startsWith("dev-only")) {
      throw new Error("JWT_SECRET must be set to a strong value in production");
    }
  }

  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === "production",
    isTest: env.NODE_ENV === "test",
    port: env.PORT,
    host: env.HOST,
    corsOrigins: env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
    databasePath: env.DATABASE_PATH,

    auth: {
      jwtSecret: env.JWT_SECRET,
      jwtTtlSeconds: env.JWT_TTL_SECONDS,
      nonceTtlSeconds: env.SIWE_NONCE_TTL_SECONDS,
    },

    chain: {
      enabled: chainEnabled,
      canSign,
      rpcUrl: env.CHAIN_RPC_URL,
      chainId: book?.chainId ?? env.CHAIN_ID,
      name: env.CHAIN_NAME,
      explorerUrl: env.CHAIN_EXPLORER_URL.replace(/\/$/, ""),
      guardianPrivateKey: env.GUARDIAN_PRIVATE_KEY,
      contracts,
    },

    ai: {
      provider: env.AI_PROVIDER,
      // Enabled only when the *selected* provider has a credential — a leftover
      // key for the other provider must not make the app claim AI is active.
      enabled:
        env.AI_PROVIDER === "gemini"
          ? Boolean(env.GEMINI_API_KEY)
          : Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
      geminiApiKey: env.GEMINI_API_KEY,
      apiKey: env.ANTHROPIC_API_KEY,
      authToken: env.ANTHROPIC_AUTH_TOKEN,
      baseUrl: env.ANTHROPIC_BASE_URL,
      model: env.AI_PROVIDER === "gemini" ? env.GEMINI_MODEL : env.ANTHROPIC_MODEL,
      effort: env.AI_EFFORT,
      timeoutMs: env.AI_TIMEOUT_MS,
      maxRpm: env.AI_MAX_RPM,
      minIntervalMs: env.AI_MIN_INTERVAL_MS,
      changeThreshold: env.AI_CHANGE_THRESHOLD,
    },

    marketData: {
      provider: env.MARKET_DATA_PROVIDER,
      coingeckoBaseUrl: env.COINGECKO_BASE_URL,
      referenceAsset: env.MARKET_REFERENCE_ASSET,
      cacheMs: env.MARKET_CACHE_MS,
    },

    risk: {
      cycleMs: env.RISK_CYCLE_MS,
      anchorIntervalMs: env.RISK_ANCHOR_INTERVAL_MS,
      predictionHorizonHours: env.PREDICTION_HORIZON_HOURS,
    },
  };
}

export const config = build();
export type Config = ReturnType<typeof build>;
