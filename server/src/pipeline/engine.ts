import { config } from "../config.js";
import { logger } from "../logger.js";
import type { DB } from "../db/index.js";
import * as repo from "../db/repositories.js";
import { analyse } from "../ai/analyst.js";
import { decide } from "../ai/guardian.js";
import { collectSignals } from "../signals/collector.js";
import type { MarketProvider } from "../signals/market.js";
import { createMarketProvider } from "../signals/market.js";
import type { ChainService } from "../chain/service.js";
import { getChainService } from "../chain/service.js";
import { bus } from "../realtime/bus.js";
import { newId } from "../util/id.js";
import { formatUsd } from "../risk/policy.js";
import type {
  ClassScores,
  GuardianDecision,
  Position,
  ProtectionEvent,
  RiskAssessment,
} from "../domain/types.js";

/**
 * The protection loop: DETECT → UNDERSTAND → DECIDE → PROTECT.
 *
 * One cycle runs per position on a fixed interval. Cycles for a given position
 * never overlap — a slow AI call or a pending chain transaction delays the next
 * cycle rather than racing it.
 */

interface PositionRuntime {
  previousClasses?: ClassScores;
  lastAnchorAt: number;
  running: boolean;
  lastBand?: string;
}

export class ProtectionEngine {
  private timer: NodeJS.Timeout | null = null;
  private readonly runtime = new Map<string, PositionRuntime>();
  private stopping = false;

  constructor(
    private readonly db: DB,
    private readonly market: MarketProvider = createMarketProvider(),
    private readonly chain: ChainService = getChainService(),
  ) {}

  start(): void {
    if (this.timer) return;
    logger.info(
      { cycleMs: config.risk.cycleMs, chain: this.chain.available, ai: config.ai.enabled },
      "protection engine started",
    );
    this.timer = setInterval(() => {
      void this.runAllPositions();
    }, config.risk.cycleMs);
    // Run one cycle immediately so a fresh dashboard is never empty.
    void this.runAllPositions();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Let any in-flight cycle finish before the process exits.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && [...this.runtime.values()].some((r) => r.running)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    logger.info("protection engine stopped");
  }

  private async runAllPositions(): Promise<void> {
    if (this.stopping) return;
    const positions = repo.listActivePositions(this.db);
    await Promise.all(positions.map((p) => this.runCycle(p).catch((err) => {
      logger.error({ err, positionId: p.id }, "protection cycle failed");
    })));
  }

  /** Runs one full loop for a position. Public so the API can force a cycle. */
  async runCycle(position: Position): Promise<RiskAssessment | null> {
    const state = this.runtimeFor(position.id);
    if (state.running) return null;
    state.running = true;

    try {
      // ---------------- DETECT ----------------
      const chainState = await this.readChainState(position);
      const injected = repo.activeInjectedEvents(this.db, position.id);
      const snapshot = await collectSignals(this.market, {
        position,
        injectedEvents: injected,
        chainState,
      });
      repo.saveSnapshot(this.db, snapshot);
      bus.publish({ type: "snapshot", positionId: position.id, payload: snapshot });

      // Keep the recorded position value in step with the vault.
      if (chainState && chainState.totalAssets > 0) {
        repo.updatePositionValue(this.db, position.id, chainState.totalAssets);
        position = { ...position, valueUsd: chainState.totalAssets };
      }

      // ---------------- UNDERSTAND ----------------
      const assessment = await analyse({
        snapshot,
        previousClasses: state.previousClasses,
        positionValueUsd: position.valueUsd,
      });
      state.previousClasses = assessment.classScores;
      repo.saveAssessment(this.db, assessment);
      bus.publish({ type: "assessment", positionId: position.id, payload: assessment });

      this.logBandChange(position.id, assessment, state);

      // Anchor on chain on its own cadence — every cycle would be wasteful and
      // the oracle only needs to be fresh, not continuous.
      await this.maybeAnchor(position.id, assessment, state);

      // ---------------- DECIDE ----------------
      const policy = repo.getOrCreatePolicy(this.db, position.id);
      const decision = await decide({
        assessment,
        policy,
        snapshot,
        positionValueUsd: position.valueUsd,
      });

      const previousPending = repo.pendingDecision(this.db, position.id);

      if (decision.finalAction === "HOLD") {
        // Nothing to approve. Record it only when it changes the picture, so
        // the log doesn't fill with identical HOLDs every few seconds.
        if (previousPending) {
          repo.setDecisionStatus(this.db, previousPending.id, "superseded");
          repo.saveDecision(this.db, { ...decision, status: "superseded" });
          bus.publish({ type: "decision", positionId: position.id, payload: decision });
        }
        return assessment;
      }

      // A live protective recommendation.
      if (previousPending && this.sameDecision(previousPending, decision)) {
        // Identical to the one already awaiting the user — leave it alone.
        return assessment;
      }

      repo.saveDecision(this.db, decision);
      repo.supersedePendingDecisions(this.db, position.id, decision.id);
      bus.publish({ type: "decision", positionId: position.id, payload: decision });

      this.activity(
        position.id,
        "warning",
        "DECIDE",
        `Guardian: ${decision.proposedAction} → ${decision.finalAction} · ${decision.policyMatch}`,
      );

      // ---------------- PROTECT ----------------
      if (policy.mode === "AUTO") {
        await this.executeDecision(position, decision, assessment);
      } else {
        this.activity(
          position.id,
          "warning",
          "DECIDE",
          `Awaiting approval — ${decision.finalAction} ${formatUsd(decision.amountUsd)}`,
        );
      }

      return assessment;
    } finally {
      state.running = false;
    }
  }

  /**
   * Executes an approved decision. Used by the AUTO path above and by the
   * manual approval endpoint.
   */
  async executeDecision(
    position: Position,
    decision: GuardianDecision,
    assessment?: RiskAssessment,
  ): Promise<ProtectionEvent> {
    const risk =
      assessment ?? repo.getAssessment(this.db, decision.assessmentId) ?? undefined;
    const riskBefore = risk?.compositeScore ?? 0;

    const event: ProtectionEvent = {
      id: newId("pev"),
      positionId: position.id,
      decisionId: decision.id,
      createdAt: Date.now(),
      action: decision.finalAction,
      amountUsd: decision.amountUsd,
      riskBefore,
      status: this.chain.canSign ? "submitted" : "simulated",
      reasoning: decision.rationale,
    };
    repo.saveProtectionEvent(this.db, event);
    repo.setDecisionStatus(this.db, decision.id, "approved");
    bus.publish({ type: "protection", positionId: position.id, payload: event });

    if (!this.chain.canSign) {
      // No signer: record the action as simulated rather than pretending it
      // settled on chain.
      this.activity(
        position.id,
        "warning",
        "PROTECT",
        `Simulated ${decision.finalAction} of ${formatUsd(decision.amountUsd)} — no chain signer configured`,
      );
      repo.setDecisionStatus(this.db, decision.id, "executed");
      return event;
    }

    this.activity(
      position.id,
      "info",
      "PROTECT",
      `ProtectionExecutor: rotating ${formatUsd(decision.amountUsd)} via OKX DEX`,
    );

    const vaultState = await this.chain.readVaultState();
    if (!vaultState) {
      return this.failEvent(position.id, decision, event, "vault state unavailable");
    }

    const amountAssetUnits =
      (vaultState.totalAssets * BigInt(decision.rotationBps)) / 10_000n;

    const result = await this.chain.executeProtection({
      amountAssetUnits,
      action: decision.finalAction,
      reasoning: decision.rationale,
      // Allow a margin over the estimate so ordinary drift doesn't revert,
      // but never more than 3% beyond what the user was shown.
      maxSlippageBps: Math.min(decision.estimatedSlippageBps + 300, 1_000),
    });

    if (!result) {
      return this.failEvent(position.id, decision, event, "execution reverted or timed out");
    }

    repo.updateProtectionEvent(this.db, event.id, {
      status: "confirmed",
      txHash: result.txHash,
    });
    repo.setDecisionStatus(this.db, decision.id, "executed");

    const confirmed: ProtectionEvent = {
      ...event,
      status: "confirmed",
      txHash: result.txHash,
    };
    bus.publish({ type: "protection", positionId: position.id, payload: confirmed });
    this.activity(
      position.id,
      "success",
      "PROTECT",
      `Confirmed — ${formatUsd(decision.amountUsd)} rotated · ${result.txHash.slice(0, 10)}…`,
    );

    return confirmed;
  }

  private failEvent(
    positionId: string,
    decision: GuardianDecision,
    event: ProtectionEvent,
    reason: string,
  ): ProtectionEvent {
    repo.updateProtectionEvent(this.db, event.id, { status: "failed", error: reason });
    repo.setDecisionStatus(this.db, decision.id, "failed");
    const failed: ProtectionEvent = { ...event, status: "failed", error: reason };
    bus.publish({ type: "protection", positionId, payload: failed });
    this.activity(positionId, "critical", "PROTECT", `Protection failed — ${reason}`);
    return failed;
  }

  private async readChainState(
    position: Position,
  ): Promise<{ defensiveShare: number; totalAssets: number } | null> {
    if (!this.chain.available) return null;
    const state = await this.chain.readVaultState();
    if (!state) return null;
    void position;
    return {
      defensiveShare: state.defensiveShare,
      totalAssets: state.totalAssetsFormatted,
    };
  }

  private async maybeAnchor(
    positionId: string,
    assessment: RiskAssessment,
    state: PositionRuntime,
  ): Promise<void> {
    if (!this.chain.canSign) return;
    if (Date.now() - state.lastAnchorAt < config.risk.anchorIntervalMs) return;

    state.lastAnchorAt = Date.now();
    const hash = await this.chain.anchorAssessment({
      score: assessment.compositeScore,
      confidence: assessment.confidence,
      escalation: assessment.escalationProbability,
      action: assessment.recommendedAction,
      reasoning: assessment.reasoning,
    });
    if (hash) {
      repo.markAssessmentAnchored(this.db, assessment.id, hash);
      this.activity(
        positionId,
        "info",
        "UNDERSTAND",
        `Risk score ${assessment.compositeScore.toFixed(0)} anchored on chain · ${hash.slice(0, 10)}…`,
      );
    }
  }

  private logBandChange(
    positionId: string,
    assessment: RiskAssessment,
    state: PositionRuntime,
  ): void {
    if (state.lastBand && state.lastBand !== assessment.band) {
      const worsening =
        ["LOW", "MEDIUM", "HIGH", "CRITICAL"].indexOf(assessment.band) >
        ["LOW", "MEDIUM", "HIGH", "CRITICAL"].indexOf(state.lastBand);
      this.activity(
        positionId,
        worsening ? "critical" : "success",
        "UNDERSTAND",
        `Risk band ${state.lastBand} → ${assessment.band} (score ${assessment.compositeScore.toFixed(0)})`,
      );
    }
    state.lastBand = assessment.band;
  }

  /** Two decisions are "the same" when acting on either would be identical. */
  private sameDecision(a: GuardianDecision, b: GuardianDecision): boolean {
    return (
      a.finalAction === b.finalAction &&
      Math.abs(a.rotationBps - b.rotationBps) < 100 &&
      a.proposedAction === b.proposedAction
    );
  }

  private activity(
    positionId: string,
    severity: "info" | "warning" | "critical" | "success",
    stage: "DETECT" | "UNDERSTAND" | "DECIDE" | "PROTECT" | "SYSTEM",
    message: string,
  ): void {
    const entry = repo.logActivity(this.db, { positionId, severity, stage, message });
    bus.publish({ type: "activity", positionId, payload: entry });
  }

  private runtimeFor(positionId: string): PositionRuntime {
    let state = this.runtime.get(positionId);
    if (!state) {
      state = { lastAnchorAt: 0, running: false };
      this.runtime.set(positionId, state);
    }
    return state;
  }
}
