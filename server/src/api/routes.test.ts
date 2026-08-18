import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { privateKeyToAccount } from "viem/accounts";

// Deterministic backend: no live market feed, no model calls, no chain.
process.env.NODE_ENV = "test";
process.env.MARKET_DATA_PROVIDER = "simulated";
process.env.RISK_CYCLE_MS = "3600000"; // the engine's own timer must not fire mid-test
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CHAIN_RPC_URL;

vi.mock("../ai/client.js", () => ({
  callStructured: vi.fn(async () => null), // exercise the deterministic path
  aiAvailable: () => false,
  getAnthropic: () => null,
}));

const { openDatabase, setDatabase, closeDatabase } = await import("../db/index.js");
const { createApp } = await import("./server.js");
const { ProtectionEngine } = await import("../pipeline/engine.js");

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const other = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
);

let app: Express;
let engine: InstanceType<typeof ProtectionEngine>;

async function signIn(who = account): Promise<string> {
  const nonceRes = await request(app)
    .post("/api/auth/nonce")
    .send({ address: who.address })
    .expect(200);

  const signature = await who.signMessage({ message: nonceRes.body.message });

  const verifyRes = await request(app)
    .post("/api/auth/verify")
    .send({ address: who.address, message: nonceRes.body.message, signature })
    .expect(200);

  return verifyRes.body.token as string;
}

async function registerPosition(token: string): Promise<string> {
  const res = await request(app)
    .post("/api/positions")
    .set("Authorization", `Bearer ${token}`)
    .send({ assetSymbol: "RWA-T3", assetName: "RWA Treasury Note T3", valueUsd: 10_000 })
    .expect(201);
  return res.body.position.id as string;
}

beforeAll(() => {
  const db = openDatabase(":memory:");
  setDatabase(db);
});

afterAll(async () => {
  await engine?.stop();
  closeDatabase();
});

beforeEach(() => {
  const db = openDatabase(":memory:");
  setDatabase(db);
  engine = new ProtectionEngine(db);
  app = createApp(engine);
});

describe("health", () => {
  it("reports service, chain and AI status", async () => {
    const res = await request(app).get("/api/health").expect(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.chain.available).toBe(false);
    expect(res.body.ai.enabled).toBe(false);
  });
});

describe("wallet authentication", () => {
  it("completes the nonce → sign → token handshake", async () => {
    const token = await signIn();
    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(me.body.address).toBe(account.address.toLowerCase());
  });

  it("rejects a signature from a different wallet", async () => {
    const nonceRes = await request(app)
      .post("/api/auth/nonce")
      .send({ address: account.address })
      .expect(200);

    // `other` signs a message issued to `account`.
    const signature = await other.signMessage({ message: nonceRes.body.message });

    await request(app)
      .post("/api/auth/verify")
      .send({ address: account.address, message: nonceRes.body.message, signature })
      .expect(401);
  });

  it("refuses to replay a nonce", async () => {
    const nonceRes = await request(app)
      .post("/api/auth/nonce")
      .send({ address: account.address })
      .expect(200);
    const signature = await account.signMessage({ message: nonceRes.body.message });
    const body = { address: account.address, message: nonceRes.body.message, signature };

    await request(app).post("/api/auth/verify").send(body).expect(200);
    // Same signature, same nonce, second time.
    await request(app).post("/api/auth/verify").send(body).expect(401);
  });

  it("rejects a malformed address", async () => {
    await request(app).post("/api/auth/nonce").send({ address: "not-an-address" }).expect(400);
  });

  it("rejects a request with no token", async () => {
    await request(app).get("/api/positions").expect(401);
  });

  it("rejects a tampered token", async () => {
    const token = await signIn();
    await request(app)
      .get("/api/positions")
      .set("Authorization", `Bearer ${token.slice(0, -4)}aaaa`)
      .expect(401);
  });
});

describe("positions", () => {
  it("registers a position, seeds its policy and produces a first assessment", async () => {
    const token = await signIn();
    const positionId = await registerPosition(token);

    const res = await request(app)
      .get(`/api/positions/${positionId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body.position.assetSymbol).toBe("RWA-T3");
    // Default policy must be MANUAL — never move funds without asking.
    expect(res.body.policy.mode).toBe("MANUAL");
    expect(res.body.policy.posture).toBe("Balanced");
    expect(res.body.assessment).toBeTruthy();
    expect(res.body.assessment.compositeScore).toBeGreaterThan(0);
    expect(res.body.assessment.band).toBe("LOW");
    expect(res.body.assessment.source).toBe("deterministic");
    expect(res.body.assessment.factors.length).toBeGreaterThan(0);
  });

  it("validates the registration payload", async () => {
    const token = await signIn();
    await request(app)
      .post("/api/positions")
      .set("Authorization", `Bearer ${token}`)
      .send({ assetSymbol: "", assetName: "x", valueUsd: -5 })
      .expect(400);
  });

  it("hides another wallet's position behind a 404", async () => {
    const tokenA = await signIn(account);
    const positionId = await registerPosition(tokenA);
    const tokenB = await signIn(other);

    await request(app)
      .get(`/api/positions/${positionId}`)
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(404);

    const listB = await request(app)
      .get("/api/positions")
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(200);
    expect(listB.body.positions).toHaveLength(0);
  });
});

describe("protection policy", () => {
  it("accepts a valid policy update", async () => {
    const token = await signIn();
    const positionId = await registerPosition(token);

    const res = await request(app)
      .put(`/api/positions/${positionId}/policy`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        posture: "Conservative",
        maxDrawdownBps: 500,
        maxExposureBps: 2_500,
        minLiquidityUsd: 500_000,
        defensiveAsset: "USDT",
        mode: "AUTO",
      })
      .expect(200);

    expect(res.body.policy.posture).toBe("Conservative");
    expect(res.body.policy.defensiveAsset).toBe("USDT");
  });

  it("rejects an unknown posture", async () => {
    const token = await signIn();
    const positionId = await registerPosition(token);
    await request(app)
      .put(`/api/positions/${positionId}/policy`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        posture: "Reckless",
        maxDrawdownBps: 500,
        maxExposureBps: 2_500,
        minLiquidityUsd: 500_000,
        defensiveAsset: "USDC",
        mode: "AUTO",
      })
      .expect(400);
  });

  it("refuses a policy update from a non-owner", async () => {
    const tokenA = await signIn(account);
    const positionId = await registerPosition(tokenA);
    const tokenB = await signIn(other);

    await request(app)
      .put(`/api/positions/${positionId}/policy`)
      .set("Authorization", `Bearer ${tokenB}`)
      .send({
        posture: "Aggressive",
        maxDrawdownBps: 1_500,
        maxExposureBps: 6_000,
        minLiquidityUsd: 100_000,
        defensiveAsset: "USDC",
        mode: "AUTO",
      })
      .expect(404);
  });
});

describe("controlled risk event → decision → approval", () => {
  it("drives the full protection loop and settles a simulated action", async () => {
    const token = await signIn();
    const positionId = await registerPosition(token);
    const auth = { Authorization: `Bearer ${token}` };

    // Baseline: calm, no pending decision.
    const before = await request(app)
      .get(`/api/positions/${positionId}`)
      .set(auth)
      .expect(200);
    expect(before.body.assessment.band).toBe("LOW");
    expect(before.body.decision).toBeNull();

    // Inject a severe issuer + liquidity + oracle scenario.
    for (const kind of ["issuer", "liquidity", "oracle"] as const) {
      await request(app)
        .post(`/api/positions/${positionId}/events`)
        .set(auth)
        .send({ kind, severity: 0.9, durationSeconds: 600 })
        .expect(201);
    }

    const after = await request(app)
      .get(`/api/positions/${positionId}`)
      .set(auth)
      .expect(200);

    // DETECT + UNDERSTAND: risk must have escalated out of the LOW band.
    expect(after.body.assessment.compositeScore).toBeGreaterThan(
      before.body.assessment.compositeScore,
    );
    expect(["MEDIUM", "HIGH", "CRITICAL"]).toContain(after.body.assessment.band);

    // DECIDE: a protective decision is pending the user's approval.
    const decision = after.body.decision;
    expect(decision).toBeTruthy();
    expect(decision.status).toBe("pending");
    expect(decision.finalAction).not.toBe("HOLD");
    expect(decision.amountUsd).toBeGreaterThan(0);
    // The Guardian must never authorise more than the Balanced ceiling.
    expect(decision.rotationBps).toBeLessThanOrEqual(3_500);
    expect(decision.checks.length).toBeGreaterThanOrEqual(6);

    // The controlled event is labelled as such in the activity log.
    const activity = await request(app)
      .get(`/api/positions/${positionId}/activity`)
      .set(auth)
      .expect(200);
    expect(
      activity.body.activity.some((a: { message: string }) =>
        a.message.includes("CONTROLLED EVENT"),
      ),
    ).toBe(true);

    // PROTECT: approve it.
    const approved = await request(app)
      .post(`/api/positions/${positionId}/decision/${decision.id}/approve`)
      .set(auth)
      .expect(200);

    // No signer configured, so the action is recorded as simulated — not as a
    // confirmed on-chain settlement.
    expect(approved.body.event.status).toBe("simulated");
    expect(approved.body.event.amountUsd).toBe(decision.amountUsd);

    // Proof: it shows up in history with its reasoning.
    const history = await request(app)
      .get(`/api/positions/${positionId}/history`)
      .set(auth)
      .expect(200);
    expect(history.body.events).toHaveLength(1);
    expect(history.body.events[0].reasoning.length).toBeGreaterThan(20);
    expect(history.body.totals.totalProtectedUsd).toBe(decision.amountUsd);
  });

  it("rejects a decision and leaves the position untouched", async () => {
    const token = await signIn();
    const positionId = await registerPosition(token);
    const auth = { Authorization: `Bearer ${token}` };

    await request(app)
      .post(`/api/positions/${positionId}/events`)
      .set(auth)
      .send({ kind: "issuer", severity: 0.95, durationSeconds: 600 })
      .expect(201);
    await request(app)
      .post(`/api/positions/${positionId}/events`)
      .set(auth)
      .send({ kind: "liquidity", severity: 0.95, durationSeconds: 600 })
      .expect(201);

    const state = await request(app).get(`/api/positions/${positionId}`).set(auth).expect(200);
    const decision = state.body.decision;
    expect(decision.status).toBe("pending");

    await request(app)
      .post(`/api/positions/${positionId}/decision/${decision.id}/reject`)
      .set(auth)
      .expect(200);

    // A rejected decision cannot then be approved.
    await request(app)
      .post(`/api/positions/${positionId}/decision/${decision.id}/approve`)
      .set(auth)
      .expect(409);

    const history = await request(app)
      .get(`/api/positions/${positionId}/history`)
      .set(auth)
      .expect(200);
    expect(history.body.events).toHaveLength(0);
  });

  it("returns the position to baseline when controlled events are cleared", async () => {
    const token = await signIn();
    const positionId = await registerPosition(token);
    const auth = { Authorization: `Bearer ${token}` };

    await request(app)
      .post(`/api/positions/${positionId}/events`)
      .set(auth)
      .send({ kind: "liquidity", severity: 0.9, durationSeconds: 600 })
      .expect(201);

    const stressed = await request(app).get(`/api/positions/${positionId}`).set(auth).expect(200);

    await request(app).delete(`/api/positions/${positionId}/events`).set(auth).expect(200);

    const recovered = await request(app).get(`/api/positions/${positionId}`).set(auth).expect(200);
    expect(recovered.body.assessment.compositeScore).toBeLessThan(
      stressed.body.assessment.compositeScore,
    );
    expect(recovered.body.injectedEvents).toHaveLength(0);
  });

  it("refuses to approve a decision belonging to another wallet's position", async () => {
    const tokenA = await signIn(account);
    const positionId = await registerPosition(tokenA);
    // A compound scenario is needed to genuinely cross the Balanced posture's
    // intervention threshold. An issuer event alone leaves the composite in the
    // MEDIUM band, where the correct outcome is HOLD and no decision is raised.
    for (const kind of ["issuer", "liquidity", "oracle"] as const) {
      await request(app)
        .post(`/api/positions/${positionId}/events`)
        .set("Authorization", `Bearer ${tokenA}`)
        .send({ kind, severity: 0.95, durationSeconds: 600 })
        .expect(201);
    }

    const state = await request(app)
      .get(`/api/positions/${positionId}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(200);

    const tokenB = await signIn(other);
    await request(app)
      .post(`/api/positions/${positionId}/decision/${state.body.decision.id}/approve`)
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(404);
  });
});

describe("unknown routes", () => {
  it("returns a JSON 404", async () => {
    const res = await request(app).get("/api/nope").expect(404);
    expect(res.body.error).toBe("not found");
  });
});
