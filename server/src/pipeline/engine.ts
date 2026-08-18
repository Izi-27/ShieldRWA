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

/**
 * How long a rejected proposal suppresses an equivalent one. Long enough that
 * declining is meaningful, short enough that a genuinely worsening position
 * can still ask again.
 */
const REJECTION_COOLDOWN_MS = 5 * 60_000;

/** How long automatic execution pauses after a failed attempt. */
const EXECUTION_RETRY_COOLDOWN_MS = 60_000;

interface PositionRuntime {
  previousClasses?: ClassScores;
  lastAnchorAt: number;
  running: boolean;
  lastBand?: string;
  /** When the Analyst last produced a model-written narrative. */
  lastNarratedAt: number;
  /** Composite score at that narration, to detect material drift since. */
  lastNarratedScore?: number;
  /** When the Guardian last consulted the model. */
  lastChallengedAt: number;
  /** Signature of the inputs it was consulted about. */
  lastChallengeKey?: string;
}

export class ProtectionEngine {
  private timer: NodeJS.Timeout | null = null;
  private readonly runtime = new Map<string, PositionRuntime>();
  /** Last anchor time per vault address — see maybeAnchor. */
  private readonly lastAnchorByVault = new Map<string, number>();
  /** Position id -> timestamp until which AUTO execution is paused. */
  private readonly executionCooldown = new Map<string, number>();
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
        shouldNarrate: (draft) => this.shouldNarrate(state, draft),
      });
      if (assessment.source === "ai") {
        state.lastNarratedAt = Date.now();
        state.lastNarratedScore = assessment.compositeScore;
      }
      state.previousClasses = assessment.classScores;
      repo.saveAssessment(this.db, assessment);
      bus.publish({ type: "assessment", positionId: position.id, payload: assessment });

      this.logBandChange(position.id, assessment, state);

      // Anchor on chain on its own cadence — every cycle would be wasteful and
      // the oracle only needs to be fresh, not continuous.
      await this.maybeAnchor(position.id, assessment, state);

      // ---------------- DECIDE ----------------
      const policy = repo.getOrCreatePolicy(this.db, position.id);
      const previousPending = repo.pendingDecision(this.db, position.id);

      const decision = await decide({
        assessment,
        policy,
        snapshot,
        positionValueUsd: position.valueUsd,
        // Only pay for a rationale when the inputs actually changed.
        //
        // This deliberately keys off engine state rather than the pending
        // decision in the database. A Guardian verdict of HOLD is never
        // persisted as pending, so a position whose economics always favour
        // holding left nothing to compare against and re-consulted the model
        // every single cycle — which is what drained the request budget.
        shouldChallenge: (draft) => this.shouldChallenge(state, draft),
      });

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

      // Respect a rejection. The user declining an action is a decision about
      // the position, not a dismissal of one dialog: re-raising an equivalent
      // proposal on the next cycle reopens the approval prompt seconds later
      // and gives them no way to say no and mean it.
      const rejected = repo.recentlyRejectedDecision(
        this.db,
        position.id,
        REJECTION_COOLDOWN_MS,
      );
      if (rejected && this.sameDecision(rejected, decision)) {
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
        // Back off after a failure. Automatic mode otherwise re-derives an
        // identical decision every cycle and re-submits a transaction that has
        // already reverted — burning gas and filling the log at cycle rate.
        const cooldownUntil = this.executionCooldown.get(position.id) ?? 0;
        if (Date.now() < cooldownUntil) {
          return assessment;
        }
        const executed = await this.executeDecision(position, decision, assessment);
        if (executed.status === "failed") {
          this.executionCooldown.set(position.id, Date.now() + EXECUTION_RETRY_COOLDOWN_MS);
          this.activity(
            position.id,
            "warning",
            "PROTECT",
            `Automatic execution paused for ${EXECUTION_RETRY_COOLDOWN_MS / 1_000}s after a failure`,
          );
        } else {
          this.executionCooldown.delete(position.id);
        }
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

    // Size the rotation against the RWA leg, not total assets.
    //
    // `totalAssets` counts value already rotated into the defensive asset, but
    // `checkoutForProtection` can only draw on the RWA the vault still holds.
    // On a heavily-rotated position the two diverge sharply — a vault 93%
    // defensive has ~7% of its value left to sell — and sizing off the total
    // produces an order the vault cannot fill, reverting with
    // InsufficientLiquidity.
    const requested = (vaultState.totalAssets * BigInt(decision.rotationBps)) / 10_000n;
    const amountAssetUnits = requested > vaultState.assetBalance
      ? vaultState.assetBalance
      : requested;

    // Refuse to send a transaction that cannot succeed.
    if (amountAssetUnits === 0n) {
      const defensivePct = (vaultState.defensiveShare * 100).toFixed(1);
      return this.failEvent(
        position.id,
        decision,
        event,
        vaultState.totalAssets === 0n
          ? "vault holds no assets — deposit into RWAPosition before protective execution can run"
          : `no exposure left to rotate — the position is already ${defensivePct}% defensive`,
      );
    }

    if (amountAssetUnits < requested) {
      // Rotating what remains is still the right action; say so rather than
      // silently protecting less than the decision promised.
      this.activity(
        position.id,
        "warning",
        "PROTECT",
        `Rotation capped at the remaining exposure — the position is already ` +
          `${(vaultState.defensiveShare * 100).toFixed(1)}% defensive`,
      );
    }

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

  /**
   * Anchoring is keyed by *vault*, not by position.
   *
   * `RiskOracle` stores one assessment per vault address, and every position
   * currently maps to the single configured vault. Tracking the interval
   * per-position therefore had N positions anchoring the same vault with the
   * same payload in the same cycle: one transaction won and the rest were
   * rejected as duplicates, burning gas budget and filling the log with nonce
   * errors for work that was redundant by construction.
   */
  private async maybeAnchor(
    positionId: string,
    assessment: RiskAssessment,
    state: PositionRuntime,
  ): Promise<void> {
    if (!this.chain.canSign) return;

    const vault = this.chain.vaultAddress ?? "unconfigured";
    const lastForVault = this.lastAnchorByVault.get(vault) ?? 0;
    if (Date.now() - lastForVault < config.risk.anchorIntervalMs) return;

    // Claim the slot before awaiting, so a concurrent cycle cannot pass the
    // same check and queue a duplicate behind us.
    this.lastAnchorByVault.set(vault, Date.now());
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

  /**
   * Is a model-written narrative worth a request this cycle?
   *
   * The composite score, bands and trajectory are recomputed every cycle for
   * free — only the *explanation* costs anything. Re-narrating an unchanged
   * picture every few seconds burns a free tier in under a minute and tells
   * the user nothing new, so the model is called when:
   *
   *   - nothing has been narrated yet,
   *   - the risk band changed (the user-visible state changed),
   *   - the score moved materially since the last narration, or
   *   - the narrative has simply gone stale.
   */
  private shouldNarrate(
    state: PositionRuntime,
    draft: { compositeScore: number; band: string },
  ): boolean {
    if (state.lastNarratedAt === 0 || state.lastNarratedScore === undefined) return true;
    if (state.lastBand !== undefined && state.lastBand !== draft.band) return true;

    const drift = Math.abs(draft.compositeScore - state.lastNarratedScore);
    if (drift >= config.ai.changeThreshold) return true;

    return Date.now() - state.lastNarratedAt >= config.ai.minIntervalMs;
  }

  /**
   * Is a model-written rationale worth a request this cycle?
   *
   * Keyed on the inputs the Guardian actually reasons about. When they are
   * unchanged the previous rationale is still accurate, so the deterministic
   * path produces the same verdict for free. The interval bound stops a
   * long-lived position re-arguing an identical case indefinitely.
   */
  private shouldChallenge(
    state: PositionRuntime,
    draft: {
      permittedAction: string;
      permittedRotationBps: number;
      proposedAction: string;
      breached: boolean;
    },
  ): boolean {
    // Round the rotation so ordinary score jitter does not read as a change.
    const key = [
      draft.proposedAction,
      draft.permittedAction,
      Math.round(draft.permittedRotationBps / 500) * 500,
      draft.breached ? "breached" : "ok",
    ].join("|");

    if (state.lastChallengeKey !== key) {
      state.lastChallengeKey = key;
      state.lastChallengedAt = Date.now();
      return true;
    }
    if (Date.now() - state.lastChallengedAt >= config.ai.minIntervalMs) {
      state.lastChallengedAt = Date.now();
      return true;
    }
    return false;
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
      state = { lastAnchorAt: 0, running: false, lastNarratedAt: 0, lastChallengedAt: 0 };
      this.runtime.set(positionId, state);
    }
    return state;
  }
}
