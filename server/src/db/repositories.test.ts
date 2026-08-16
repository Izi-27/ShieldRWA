import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "./index.js";
import {
  DEFAULT_POLICY,
  activeInjectedEvents,
  clearInjectedEvents,
  consumeNonce,
  createNonce,
  createPosition,
  getOrCreatePolicy,
  injectEvent,
  latestAssessment,
  listActivity,
  listPositions,
  logActivity,
  pendingDecision,
  protectionTotals,
  purgeExpiredNonces,
  saveAssessment,
  saveDecision,
  saveProtectionEvent,
  setDecisionStatus,
  supersedePendingDecisions,
  updateProtectionEvent,
  upsertPolicy,
  upsertUser,
} from "./repositories.js";
import type { GuardianDecision, RiskAssessment } from "../domain/types.js";

let db: DB;
const ADDRESS = "0x4f2ca1b2c3d4e5f60718293a4b5c6d7e8f901a19";

beforeEach(() => {
  db = openDatabase(":memory:");
  upsertUser(db, ADDRESS);
});

describe("migrations", () => {
  it("brings a fresh database to the latest version", () => {
    const version = db.pragma("user_version", { simple: true }) as number;
    expect(version).toBe(2);
  });

  it("is idempotent — re-running applies nothing", () => {
    const before = db.pragma("user_version", { simple: true });
    const second = openDatabase(":memory:");
    expect(second.pragma("user_version", { simple: true })).toBe(before);
    second.close();
  });
});

describe("nonces", () => {
  it("consumes a valid nonce exactly once", () => {
    createNonce(db, "abc123", ADDRESS, 300);
    expect(consumeNonce(db, "abc123", ADDRESS)).toBe(true);
    // A replay of the same nonce must fail.
    expect(consumeNonce(db, "abc123", ADDRESS)).toBe(false);
  });

  it("rejects a nonce issued to a different address", () => {
    createNonce(db, "abc123", ADDRESS, 300);
    expect(consumeNonce(db, "abc123", "0x0000000000000000000000000000000000000001")).toBe(false);
  });

  it("rejects an expired nonce", () => {
    createNonce(db, "old", ADDRESS, 300, Date.now() - 600_000);
    expect(consumeNonce(db, "old", ADDRESS)).toBe(false);
  });

  it("purges expired nonces", () => {
    createNonce(db, "old", ADDRESS, 300, Date.now() - 600_000);
    createNonce(db, "fresh", ADDRESS, 300);
    expect(purgeExpiredNonces(db)).toBe(1);
    expect(consumeNonce(db, "fresh", ADDRESS)).toBe(true);
  });
});

describe("positions and policies", () => {
  it("creates a position scoped to its owner", () => {
    const position = createPosition(db, {
      ownerAddress: ADDRESS,
      assetSymbol: "RWA-T3",
      assetName: "RWA Treasury Note T3",
      valueUsd: 10_000,
    });
    expect(position.status).toBe("active");
    expect(listPositions(db, ADDRESS)).toHaveLength(1);
    expect(listPositions(db, "0x0000000000000000000000000000000000000009")).toHaveLength(0);
  });

  it("creates the documented default policy on first read", () => {
    const p = createPosition(db, {
      ownerAddress: ADDRESS,
      assetSymbol: "RWA-T3",
      assetName: "n",
      valueUsd: 10_000,
    });
    const policy = getOrCreatePolicy(db, p.id);
    expect(policy.posture).toBe(DEFAULT_POLICY.posture);
    // MANUAL by default: never move a user's funds without asking first.
    expect(policy.mode).toBe("MANUAL");
  });

  it("updates a policy in place rather than duplicating it", () => {
    const p = createPosition(db, {
      ownerAddress: ADDRESS,
      assetSymbol: "RWA-T3",
      assetName: "n",
      valueUsd: 10_000,
    });
    getOrCreatePolicy(db, p.id);
    const updated = upsertPolicy(db, {
      positionId: p.id,
      posture: "Conservative",
      maxDrawdownBps: 500,
      maxExposureBps: 2_500,
      minLiquidityUsd: 500_000,
      defensiveAsset: "USDT",
      mode: "AUTO",
    });
    expect(updated.posture).toBe("Conservative");
    expect(updated.mode).toBe("AUTO");
    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM policies WHERE position_id = ?`)
      .get(p.id) as { c: number };
    expect(count.c).toBe(1);
  });

  it("cascades deletes from a position to its policy", () => {
    const p = createPosition(db, {
      ownerAddress: ADDRESS,
      assetSymbol: "X",
      assetName: "n",
      valueUsd: 1,
    });
    getOrCreatePolicy(db, p.id);
    db.prepare(`DELETE FROM positions WHERE id = ?`).run(p.id);
    const rows = db.prepare(`SELECT COUNT(*) AS c FROM policies`).get() as { c: number };
    expect(rows.c).toBe(0);
  });
});

function seedAssessment(positionId: string, score = 74): RiskAssessment {
  const a: RiskAssessment = {
    id: `asm_${score}_${Math.random().toString(36).slice(2, 8)}`,
    positionId,
    createdAt: Date.now(),
    compositeScore: score,
    band: "HIGH",
    confidence: 84,
    escalationProbability: 70,
    recommendedAction: "EXIT",
    classScores: { market: 60, asset: 80, onchain: 70, portfolio: 40, predictive: 80 },
    factors: [{ label: "Oracle deviation", weight: 0.4, severity: 80 }],
    trajectory: [{ hour: 0, score }],
    reasoning: "test reasoning",
    source: "deterministic",
  };
  saveAssessment(db, a);
  return a;
}

function seedDecision(positionId: string, assessmentId: string): GuardianDecision {
  const d: GuardianDecision = {
    id: `dec_${Math.random().toString(36).slice(2, 8)}`,
    positionId,
    assessmentId,
    createdAt: Date.now(),
    proposedAction: "EXIT",
    finalAction: "REDUCE",
    rotationBps: 3_500,
    amountUsd: 3_500,
    estimatedSlippageBps: 140,
    modelledDownsideBps: 520,
    policyMatch: "EXIT exceeds posture",
    rationale: "reduced to minimum effective intervention",
    checks: [{ key: "POLICY MATCH", value: "reduced", verdict: "warn" }],
    source: "deterministic",
    status: "pending",
  };
  saveDecision(db, d);
  return d;
}

describe("assessments and decisions", () => {
  it("round-trips an assessment through its JSON columns", () => {
    const p = createPosition(db, {
      ownerAddress: ADDRESS,
      assetSymbol: "X",
      assetName: "n",
      valueUsd: 10_000,
    });
    const a = seedAssessment(p.id);
    const loaded = latestAssessment(db, p.id);
    expect(loaded?.id).toBe(a.id);
    expect(loaded?.classScores.asset).toBe(80);
    expect(loaded?.factors[0]?.label).toBe("Oracle deviation");
    expect(loaded?.trajectory).toHaveLength(1);
  });

  it("returns only the pending decision, and supersedes older ones", () => {
    const p = createPosition(db, {
      ownerAddress: ADDRESS,
      assetSymbol: "X",
      assetName: "n",
      valueUsd: 10_000,
    });
    const a1 = seedAssessment(p.id, 70);
    const first = seedDecision(p.id, a1.id);
    const a2 = seedAssessment(p.id, 80);
    const second = seedDecision(p.id, a2.id);

    const superseded = supersedePendingDecisions(db, p.id, second.id);
    expect(superseded).toBe(1);
    expect(pendingDecision(db, p.id)?.id).toBe(second.id);

    setDecisionStatus(db, second.id, "approved");
    expect(pendingDecision(db, p.id)).toBeNull();
    expect(first.id).not.toBe(second.id);
  });
});

describe("protection events", () => {
  it("counts only settled events toward the protected total", () => {
    const p = createPosition(db, {
      ownerAddress: ADDRESS,
      assetSymbol: "X",
      assetName: "n",
      valueUsd: 10_000,
    });
    const a = seedAssessment(p.id);
    const d = seedDecision(p.id, a.id);

    saveProtectionEvent(db, {
      id: "pev_1",
      positionId: p.id,
      decisionId: d.id,
      createdAt: Date.now(),
      action: "REDUCE",
      amountUsd: 3_500,
      riskBefore: 74,
      status: "submitted",
      reasoning: "r",
    });
    // Still in flight — must not be counted.
    expect(protectionTotals(db, p.id)).toEqual({ count: 0, totalProtectedUsd: 0 });

    updateProtectionEvent(db, "pev_1", { status: "confirmed", txHash: "0xabc", riskAfter: 26 });
    expect(protectionTotals(db, p.id)).toEqual({ count: 1, totalProtectedUsd: 3_500 });

    saveProtectionEvent(db, {
      id: "pev_2",
      positionId: p.id,
      decisionId: null,
      createdAt: Date.now(),
      action: "REDUCE",
      amountUsd: 1_000,
      riskBefore: 60,
      status: "failed",
      reasoning: "r",
      error: "reverted",
    });
    // A failed event protected nothing.
    expect(protectionTotals(db, p.id).totalProtectedUsd).toBe(3_500);
  });
});

describe("activity log", () => {
  it("returns newest first", () => {
    const p = createPosition(db, {
      ownerAddress: ADDRESS,
      assetSymbol: "X",
      assetName: "n",
      valueUsd: 1,
    });
    logActivity(db, { positionId: p.id, severity: "info", stage: "DETECT", message: "first" });
    logActivity(db, { positionId: p.id, severity: "warning", stage: "DECIDE", message: "second" });
    const entries = listActivity(db, p.id);
    expect(entries[0]?.message).toBe("second");
    expect(entries[1]?.message).toBe("first");
  });
});

describe("injected events", () => {
  it("returns only unexpired events and can clear them", () => {
    const p = createPosition(db, {
      ownerAddress: ADDRESS,
      assetSymbol: "X",
      assetName: "n",
      valueUsd: 1,
    });
    injectEvent(db, {
      positionId: p.id,
      kind: "issuer",
      severity: 0.85,
      durationMs: 60_000,
      description: "Repayment delay",
    });
    injectEvent(db, {
      positionId: p.id,
      kind: "liquidity",
      severity: 0.5,
      durationMs: -1_000, // already expired
      description: "old",
    });

    const active = activeInjectedEvents(db, p.id);
    expect(active).toHaveLength(1);
    expect(active[0]?.kind).toBe("issuer");

    expect(clearInjectedEvents(db, p.id)).toBe(1);
    expect(activeInjectedEvents(db, p.id)).toHaveLength(0);
  });
});
