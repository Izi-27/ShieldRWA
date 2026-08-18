import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config } from "../config.js";
import { getDatabase } from "../db/index.js";
import * as repo from "../db/repositories.js";
import { AuthError, issueNonce, verifySignIn } from "../auth/siwe.js";
import { requireAuth, requirePositionOwner } from "../auth/middleware.js";
import { getChainService } from "../chain/service.js";
import { budgetStatus } from "../ai/budget.js";
import type { ProtectionEngine } from "../pipeline/engine.js";
import { POSTURES } from "../domain/types.js";
import { logger } from "../logger.js";

/**
 * HTTP surface. Every position-scoped route runs `requireAuth` then
 * `requirePositionOwner`, so authorisation is never left to the handler.
 */

/**
 * Limiters are built per router rather than at module scope: each holds its own
 * hit counters, and a shared instance would leak state between apps (and
 * between tests). Disabled under NODE_ENV=test so suites aren't throttled.
 */
function buildLimiters() {
  if (config.isTest) {
    const passthrough = (_req: Request, _res: Response, next: () => void) => next();
    return { authLimiter: passthrough, writeLimiter: passthrough };
  }
  return {
    authLimiter: rateLimit({
      windowMs: 60_000,
      limit: 20,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { error: "too many authentication attempts, try again shortly" },
    }),
    writeLimiter: rateLimit({
      windowMs: 60_000,
      limit: 60,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
  };
}

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "invalid address");

const registerPositionSchema = z.object({
  assetSymbol: z.string().min(1).max(24),
  assetName: z.string().min(1).max(120),
  valueUsd: z.number().positive().max(1_000_000_000),
  vaultAddress: addressSchema.optional(),
});

const policySchema = z.object({
  posture: z.enum(POSTURES),
  maxDrawdownBps: z.number().int().min(100).max(5_000),
  maxExposureBps: z.number().int().min(500).max(10_000),
  minLiquidityUsd: z.number().min(0).max(100_000_000),
  defensiveAsset: z.enum(["USDC", "USDT"]),
  mode: z.enum(["AUTO", "MANUAL"]),
});

const injectSchema = z.object({
  kind: z.enum(["issuer", "liquidity", "oracle"]),
  severity: z.number().min(0).max(1).default(0.85),
  durationSeconds: z.number().int().min(10).max(3_600).default(300),
  description: z.string().min(3).max(200).optional(),
});

export function buildRoutes(engine: ProtectionEngine): Router {
  const router = Router();
  const db = getDatabase();
  const chain = getChainService();
  const { authLimiter, writeLimiter } = buildLimiters();

  /* ------------------------------------------------------------- health */

  router.get("/health", async (_req: Request, res: Response) => {
    const chainHealth = await chain.health();
    res.json({
      status: "ok",
      env: config.env,
      time: new Date().toISOString(),
      chain: chainHealth,
      ai: {
        enabled: config.ai.enabled,
        provider: config.ai.provider,
        model: config.ai.enabled ? config.ai.model : null,
        budget: budgetStatus(),
      },
      marketData: config.marketData.provider,
    });
  });

  /* --------------------------------------------------------------- auth */

  router.post("/auth/nonce", authLimiter, (req: Request, res: Response) => {
    const parsed = z.object({ address: addressSchema }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
      return;
    }
    const domain = req.get("host") ?? "shieldrwa.local";
    const result = issueNonce(db, parsed.data.address, domain);
    res.json(result);
  });

  router.post("/auth/verify", authLimiter, async (req: Request, res: Response) => {
    const parsed = z
      .object({
        address: addressSchema,
        message: z.string().min(20).max(2_000),
        signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
      return;
    }
    try {
      const result = await verifySignIn(db, parsed.data);
      res.json(result);
    } catch (err) {
      const status = err instanceof AuthError ? err.status : 401;
      res.status(status).json({ error: err instanceof Error ? err.message : "unauthorised" });
    }
  });

  router.get("/auth/me", requireAuth, (req: Request, res: Response) => {
    res.json({ address: req.address, chainId: config.chain.chainId });
  });

  /* ---------------------------------------------------------- positions */

  router.get("/positions", requireAuth, (req: Request, res: Response) => {
    res.json({ positions: repo.listPositions(db, req.address!) });
  });

  router.post("/positions", requireAuth, writeLimiter, (req: Request, res: Response) => {
    const parsed = registerPositionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
      return;
    }

    const position = repo.createPosition(db, {
      ownerAddress: req.address!,
      assetSymbol: parsed.data.assetSymbol,
      assetName: parsed.data.assetName,
      valueUsd: parsed.data.valueUsd,
      vaultAddress: parsed.data.vaultAddress ?? config.chain.contracts.rwaPosition ?? null,
    });
    const policy = repo.getOrCreatePolicy(db, position.id);
    repo.logActivity(db, {
      positionId: position.id,
      severity: "success",
      stage: "SYSTEM",
      message: `Position registered — ${position.assetSymbol}`,
    });

    // Produce a first assessment straight away so the dashboard has data.
    void engine.runCycle(position).catch((err) =>
      logger.error({ err, positionId: position.id }, "initial cycle failed"),
    );

    res.status(201).json({ position, policy });
  });

  router.get(
    "/positions/:positionId",
    requireAuth,
    requirePositionOwner,
    (req: Request, res: Response) => {
      const positionId = req.params.positionId!;
      const position = repo.getPosition(db, positionId)!;
      const assessment = repo.latestAssessment(db, positionId);
      const decision = repo.pendingDecision(db, positionId) ?? repo.latestDecision(db, positionId);
      const totals = repo.protectionTotals(db, positionId);

      res.json({
        position,
        policy: repo.getOrCreatePolicy(db, positionId),
        assessment,
        decision,
        activity: repo.listActivity(db, positionId, 30),
        injectedEvents: repo.activeInjectedEvents(db, positionId),
        totals,
      });
    },
  );

  /* ------------------------------------------------------------- policy */

  router.put(
    "/positions/:positionId/policy",
    requireAuth,
    requirePositionOwner,
    writeLimiter,
    (req: Request, res: Response) => {
      const parsed = policySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid policy" });
        return;
      }
      const positionId = req.params.positionId!;
      const policy = repo.upsertPolicy(db, { positionId, ...parsed.data });
      repo.logActivity(db, {
        positionId,
        severity: "info",
        stage: "SYSTEM",
        message: `Protection policy updated — ${policy.posture}, ${policy.mode}`,
      });
      res.json({ policy });
    },
  );

  /* -------------------------------------------------------- assessments */

  router.get(
    "/positions/:positionId/assessments",
    requireAuth,
    requirePositionOwner,
    (req: Request, res: Response) => {
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      res.json({ assessments: repo.listAssessments(db, req.params.positionId!, limit) });
    },
  );

  /* ---------------------------------------------------------- decisions */

  router.get(
    "/positions/:positionId/decision",
    requireAuth,
    requirePositionOwner,
    (req: Request, res: Response) => {
      const positionId = req.params.positionId!;
      res.json({
        pending: repo.pendingDecision(db, positionId),
        latest: repo.latestDecision(db, positionId),
      });
    },
  );

  router.post(
    "/positions/:positionId/decision/:decisionId/approve",
    requireAuth,
    requirePositionOwner,
    writeLimiter,
    async (req: Request, res: Response) => {
      const positionId = req.params.positionId!;
      const decision = repo.getDecision(db, req.params.decisionId!);

      if (!decision || decision.positionId !== positionId) {
        res.status(404).json({ error: "decision not found" });
        return;
      }
      if (decision.status !== "pending") {
        res.status(409).json({ error: `decision is already ${decision.status}` });
        return;
      }

      const position = repo.getPosition(db, positionId)!;
      repo.logActivity(db, {
        positionId,
        severity: "info",
        stage: "PROTECT",
        message: `User approved ${decision.finalAction} — executing`,
      });

      try {
        const event = await engine.executeDecision(position, decision);
        res.json({ event });
      } catch (err) {
        logger.error({ err, decisionId: decision.id }, "approval execution failed");
        res.status(500).json({ error: "execution failed" });
      }
    },
  );

  router.post(
    "/positions/:positionId/decision/:decisionId/reject",
    requireAuth,
    requirePositionOwner,
    writeLimiter,
    (req: Request, res: Response) => {
      const positionId = req.params.positionId!;
      const decision = repo.getDecision(db, req.params.decisionId!);

      if (!decision || decision.positionId !== positionId) {
        res.status(404).json({ error: "decision not found" });
        return;
      }
      if (decision.status !== "pending") {
        res.status(409).json({ error: `decision is already ${decision.status}` });
        return;
      }

      repo.setDecisionStatus(db, decision.id, "rejected");
      repo.logActivity(db, {
        positionId,
        severity: "warning",
        stage: "DECIDE",
        message: "User rejected the protective action — position held",
      });
      res.json({ decision: { ...decision, status: "rejected" } });
    },
  );

  /* ------------------------------------------------------------ history */

  router.get(
    "/positions/:positionId/history",
    requireAuth,
    requirePositionOwner,
    (req: Request, res: Response) => {
      const positionId = req.params.positionId!;
      const events = repo.listProtectionEvents(db, positionId, 100);
      const totals = repo.protectionTotals(db, positionId);
      res.json({
        events: events.map((e) => ({
          ...e,
          explorerUrl: e.txHash ? chain.txUrl(e.txHash) : null,
        })),
        totals,
      });
    },
  );

  router.get(
    "/positions/:positionId/activity",
    requireAuth,
    requirePositionOwner,
    (req: Request, res: Response) => {
      const limit = Math.min(Number(req.query.limit ?? 40), 200);
      res.json({ activity: repo.listActivity(db, req.params.positionId!, limit) });
    },
  );

  /* ---------------------------------------------- controlled risk events */

  const DESCRIPTIONS = {
    issuer: "Issuer repayment delay flagged",
    liquidity: "Primary pool depth withdrawn",
    oracle: "Oracle price deviation detected",
  } as const;

  router.post(
    "/positions/:positionId/events",
    requireAuth,
    requirePositionOwner,
    writeLimiter,
    async (req: Request, res: Response) => {
      const parsed = injectSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid event" });
        return;
      }
      const positionId = req.params.positionId!;
      const { kind, severity, durationSeconds, description } = parsed.data;

      const event = repo.injectEvent(db, {
        positionId,
        kind,
        severity,
        durationMs: durationSeconds * 1_000,
        description: description ?? DESCRIPTIONS[kind],
      });

      repo.logActivity(db, {
        positionId,
        severity: "critical",
        stage: "DETECT",
        // Injected events are labelled as controlled so the log never implies
        // an observed event when one was triggered.
        message: `CONTROLLED EVENT — ${event.description} (severity ${(severity * 100).toFixed(0)}%)`,
      });

      const position = repo.getPosition(db, positionId)!;
      await engine.runCycle(position).catch((err) =>
        logger.error({ err, positionId }, "cycle after event injection failed"),
      );

      res.status(201).json({ event });
    },
  );

  router.delete(
    "/positions/:positionId/events",
    requireAuth,
    requirePositionOwner,
    writeLimiter,
    async (req: Request, res: Response) => {
      const positionId = req.params.positionId!;
      const cleared = repo.clearInjectedEvents(db, positionId);
      repo.logActivity(db, {
        positionId,
        severity: "success",
        stage: "DETECT",
        message: "Controlled events cleared — signals returning to baseline",
      });
      const position = repo.getPosition(db, positionId)!;
      await engine.runCycle(position).catch(() => undefined);
      res.json({ cleared });
    },
  );

  return router;
}
