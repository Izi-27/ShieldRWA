import type { DB } from "./index.js";
import type {
  ActivityEntry,
  Action,
  GuardianCheck,
  GuardianDecision,
  InjectedEvent,
  Position,
  ProtectionEvent,
  ProtectionPolicy,
  RiskAssessment,
  SignalSnapshot,
} from "../domain/types.js";
import { defaultExposureCapBps } from "../domain/types.js";
import { newId } from "../util/id.js";

/**
 * Data access. Every read returns fully-typed domain objects; JSON columns are
 * parsed here so no caller ever handles a raw row.
 */

/* ------------------------------------------------------------------ users */

export function upsertUser(db: DB, address: string, now = Date.now()): void {
  db.prepare(
    `INSERT INTO users (address, created_at, last_seen_at)
     VALUES (?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).run(address.toLowerCase(), now, now);
}

/* ----------------------------------------------------------------- nonces */

export function createNonce(
  db: DB,
  nonce: string,
  address: string,
  ttlSeconds: number,
  now = Date.now(),
): void {
  db.prepare(
    `INSERT INTO auth_nonces (nonce, address, issued_at, expires_at) VALUES (?, ?, ?, ?)`,
  ).run(nonce, address.toLowerCase(), now, now + ttlSeconds * 1_000);
}

export function consumeNonce(
  db: DB,
  nonce: string,
  address: string,
  now = Date.now(),
): boolean {
  const row = db
    .prepare(
      `SELECT nonce, expires_at AS expiresAt, consumed_at AS consumedAt
       FROM auth_nonces WHERE nonce = ? AND address = ?`,
    )
    .get(nonce, address.toLowerCase()) as
    | { nonce: string; expiresAt: number; consumedAt: number | null }
    | undefined;

  if (!row || row.consumedAt !== null || row.expiresAt < now) return false;

  const result = db
    .prepare(`UPDATE auth_nonces SET consumed_at = ? WHERE nonce = ? AND consumed_at IS NULL`)
    .run(now, nonce);
  // Guards against two requests racing to redeem the same nonce.
  return result.changes === 1;
}

export function purgeExpiredNonces(db: DB, now = Date.now()): number {
  return db.prepare(`DELETE FROM auth_nonces WHERE expires_at < ?`).run(now).changes;
}

/* -------------------------------------------------------------- positions */

interface PositionRow {
  id: string;
  owner_address: string;
  vault_address: string | null;
  asset_symbol: string;
  asset_name: string;
  value_usd: number;
  shares: string;
  status: Position["status"];
  created_at: number;
  updated_at: number;
}

const toPosition = (r: PositionRow): Position => ({
  id: r.id,
  ownerAddress: r.owner_address,
  vaultAddress: r.vault_address,
  assetSymbol: r.asset_symbol,
  assetName: r.asset_name,
  valueUsd: r.value_usd,
  shares: r.shares,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function createPosition(
  db: DB,
  input: {
    ownerAddress: string;
    assetSymbol: string;
    assetName: string;
    valueUsd: number;
    vaultAddress?: string | null;
  },
  now = Date.now(),
): Position {
  const id = newId("pos");
  db.prepare(
    `INSERT INTO positions
       (id, owner_address, vault_address, asset_symbol, asset_name, value_usd, shares, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '0', 'active', ?, ?)`,
  ).run(
    id,
    input.ownerAddress.toLowerCase(),
    input.vaultAddress ?? null,
    input.assetSymbol,
    input.assetName,
    input.valueUsd,
    now,
    now,
  );
  return getPosition(db, id)!;
}

export function getPosition(db: DB, id: string): Position | null {
  const row = db.prepare(`SELECT * FROM positions WHERE id = ?`).get(id) as
    | PositionRow
    | undefined;
  return row ? toPosition(row) : null;
}

export function listPositions(db: DB, ownerAddress: string): Position[] {
  const rows = db
    .prepare(`SELECT * FROM positions WHERE owner_address = ? ORDER BY created_at DESC`)
    .all(ownerAddress.toLowerCase()) as PositionRow[];
  return rows.map(toPosition);
}

export function listActivePositions(db: DB): Position[] {
  const rows = db
    .prepare(`SELECT * FROM positions WHERE status = 'active' ORDER BY created_at ASC`)
    .all() as PositionRow[];
  return rows.map(toPosition);
}

export function updatePositionValue(
  db: DB,
  id: string,
  valueUsd: number,
  shares?: string,
  now = Date.now(),
): void {
  if (shares !== undefined) {
    db.prepare(`UPDATE positions SET value_usd = ?, shares = ?, updated_at = ? WHERE id = ?`).run(
      valueUsd,
      shares,
      now,
      id,
    );
  } else {
    db.prepare(`UPDATE positions SET value_usd = ?, updated_at = ? WHERE id = ?`).run(
      valueUsd,
      now,
      id,
    );
  }
}

export function setPositionVault(db: DB, id: string, vaultAddress: string, now = Date.now()): void {
  db.prepare(`UPDATE positions SET vault_address = ?, updated_at = ? WHERE id = ?`).run(
    vaultAddress,
    now,
    id,
  );
}

/* --------------------------------------------------------------- policies */

interface PolicyRow {
  position_id: string;
  posture: ProtectionPolicy["posture"];
  max_drawdown_bps: number;
  max_exposure_bps: number;
  min_liquidity_usd: number;
  defensive_asset: string;
  mode: ProtectionPolicy["mode"];
  updated_at: number;
}

const toPolicy = (r: PolicyRow): ProtectionPolicy => ({
  positionId: r.position_id,
  posture: r.posture,
  maxDrawdownBps: r.max_drawdown_bps,
  maxExposureBps: r.max_exposure_bps,
  minLiquidityUsd: r.min_liquidity_usd,
  defensiveAsset: r.defensive_asset,
  mode: r.mode,
  updatedAt: r.updated_at,
});

export const DEFAULT_POLICY = {
  posture: "Balanced" as const,
  maxDrawdownBps: 1_000,
  // Derived from where a position actually starts rather than a fixed number,
  // so a new policy is never breached on creation. See defaultExposureCapBps.
  maxExposureBps: defaultExposureCapBps(),
  minLiquidityUsd: 250_000,
  defensiveAsset: "USDC",
  mode: "MANUAL" as const,
};

export function upsertPolicy(
  db: DB,
  policy: Omit<ProtectionPolicy, "updatedAt">,
  now = Date.now(),
): ProtectionPolicy {
  db.prepare(
    `INSERT INTO policies
       (position_id, posture, max_drawdown_bps, max_exposure_bps, min_liquidity_usd, defensive_asset, mode, updated_at)
     VALUES (@positionId, @posture, @maxDrawdownBps, @maxExposureBps, @minLiquidityUsd, @defensiveAsset, @mode, @updatedAt)
     ON CONFLICT(position_id) DO UPDATE SET
       posture = excluded.posture,
       max_drawdown_bps = excluded.max_drawdown_bps,
       max_exposure_bps = excluded.max_exposure_bps,
       min_liquidity_usd = excluded.min_liquidity_usd,
       defensive_asset = excluded.defensive_asset,
       mode = excluded.mode,
       updated_at = excluded.updated_at`,
  ).run({ ...policy, updatedAt: now });
  return getPolicy(db, policy.positionId)!;
}

export function getPolicy(db: DB, positionId: string): ProtectionPolicy | null {
  const row = db.prepare(`SELECT * FROM policies WHERE position_id = ?`).get(positionId) as
    | PolicyRow
    | undefined;
  return row ? toPolicy(row) : null;
}

/** Returns the stored policy, creating the documented default if absent. */
export function getOrCreatePolicy(db: DB, positionId: string): ProtectionPolicy {
  return getPolicy(db, positionId) ?? upsertPolicy(db, { positionId, ...DEFAULT_POLICY });
}

/* --------------------------------------------------------------- signals */

export function saveSnapshot(db: DB, snapshot: SignalSnapshot): void {
  db.prepare(
    `INSERT INTO signal_snapshots
       (position_id, captured_at, market_json, asset_json, onchain_json, portfolio_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    snapshot.positionId,
    snapshot.capturedAt,
    JSON.stringify(snapshot.market),
    JSON.stringify(snapshot.asset),
    JSON.stringify(snapshot.onchain),
    JSON.stringify(snapshot.portfolio),
  );
}

export function pruneSnapshots(db: DB, keepPerPosition = 500): void {
  db.prepare(
    `DELETE FROM signal_snapshots
     WHERE id NOT IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY position_id ORDER BY captured_at DESC) AS rn
         FROM signal_snapshots
       ) WHERE rn <= ?
     )`,
  ).run(keepPerPosition);
}

/* ------------------------------------------------------------ assessments */

interface AssessmentRow {
  id: string;
  position_id: string;
  created_at: number;
  composite_score: number;
  band: RiskAssessment["band"];
  confidence: number;
  escalation_probability: number;
  recommended_action: Action;
  class_scores_json: string;
  factors_json: string;
  trajectory_json: string;
  reasoning: string;
  source: RiskAssessment["source"];
  anchor_tx_hash: string | null;
  anchored_at: number | null;
}

const toAssessment = (r: AssessmentRow): RiskAssessment => ({
  id: r.id,
  positionId: r.position_id,
  createdAt: r.created_at,
  compositeScore: r.composite_score,
  band: r.band,
  confidence: r.confidence,
  escalationProbability: r.escalation_probability,
  recommendedAction: r.recommended_action,
  classScores: JSON.parse(r.class_scores_json),
  factors: JSON.parse(r.factors_json),
  trajectory: JSON.parse(r.trajectory_json),
  reasoning: r.reasoning,
  source: r.source,
  anchorTxHash: r.anchor_tx_hash,
  anchoredAt: r.anchored_at,
});

export function saveAssessment(db: DB, a: RiskAssessment): void {
  db.prepare(
    `INSERT INTO assessments
       (id, position_id, created_at, composite_score, band, confidence, escalation_probability,
        recommended_action, class_scores_json, factors_json, trajectory_json, reasoning, source,
        anchor_tx_hash, anchored_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    a.id,
    a.positionId,
    a.createdAt,
    a.compositeScore,
    a.band,
    a.confidence,
    a.escalationProbability,
    a.recommendedAction,
    JSON.stringify(a.classScores),
    JSON.stringify(a.factors),
    JSON.stringify(a.trajectory),
    a.reasoning,
    a.source,
    a.anchorTxHash ?? null,
    a.anchoredAt ?? null,
  );
}

export function markAssessmentAnchored(
  db: DB,
  id: string,
  txHash: string,
  now = Date.now(),
): void {
  db.prepare(`UPDATE assessments SET anchor_tx_hash = ?, anchored_at = ? WHERE id = ?`).run(
    txHash,
    now,
    id,
  );
}

export function latestAssessment(db: DB, positionId: string): RiskAssessment | null {
  const row = db
    .prepare(
      `SELECT * FROM assessments WHERE position_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(positionId) as AssessmentRow | undefined;
  return row ? toAssessment(row) : null;
}

export function listAssessments(db: DB, positionId: string, limit = 50): RiskAssessment[] {
  const rows = db
    .prepare(`SELECT * FROM assessments WHERE position_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(positionId, limit) as AssessmentRow[];
  return rows.map(toAssessment);
}

export function getAssessment(db: DB, id: string): RiskAssessment | null {
  const row = db.prepare(`SELECT * FROM assessments WHERE id = ?`).get(id) as
    | AssessmentRow
    | undefined;
  return row ? toAssessment(row) : null;
}

export function pruneAssessments(db: DB, keepPerPosition = 200): void {
  db.prepare(
    `DELETE FROM assessments
     WHERE anchor_tx_hash IS NULL
       AND id NOT IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY position_id ORDER BY created_at DESC) AS rn
           FROM assessments
         ) WHERE rn <= ?
       )
       AND id NOT IN (SELECT assessment_id FROM decisions)`,
  ).run(keepPerPosition);
}

/* --------------------------------------------------------------- decisions */

interface DecisionRow {
  id: string;
  position_id: string;
  assessment_id: string;
  created_at: number;
  proposed_action: Action;
  final_action: Action;
  rotation_bps: number;
  amount_usd: number;
  estimated_slippage_bps: number;
  modelled_downside_bps: number;
  policy_match: string;
  rationale: string;
  checks_json: string;
  source: GuardianDecision["source"];
  status: GuardianDecision["status"];
  resolved_at: number | null;
}

const toDecision = (r: DecisionRow): GuardianDecision => ({
  id: r.id,
  positionId: r.position_id,
  assessmentId: r.assessment_id,
  createdAt: r.created_at,
  proposedAction: r.proposed_action,
  finalAction: r.final_action,
  rotationBps: r.rotation_bps,
  amountUsd: r.amount_usd,
  estimatedSlippageBps: r.estimated_slippage_bps,
  modelledDownsideBps: r.modelled_downside_bps,
  policyMatch: r.policy_match,
  rationale: r.rationale,
  checks: JSON.parse(r.checks_json) as GuardianCheck[],
  source: r.source,
  status: r.status,
  resolvedAt: r.resolved_at,
});

export function saveDecision(db: DB, d: GuardianDecision): void {
  db.prepare(
    `INSERT INTO decisions
       (id, position_id, assessment_id, created_at, proposed_action, final_action, rotation_bps,
        amount_usd, estimated_slippage_bps, modelled_downside_bps, policy_match, rationale,
        checks_json, source, status, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    d.id,
    d.positionId,
    d.assessmentId,
    d.createdAt,
    d.proposedAction,
    d.finalAction,
    d.rotationBps,
    d.amountUsd,
    d.estimatedSlippageBps,
    d.modelledDownsideBps,
    d.policyMatch,
    d.rationale,
    JSON.stringify(d.checks),
    d.source,
    d.status,
    d.resolvedAt ?? null,
  );
}

export function getDecision(db: DB, id: string): GuardianDecision | null {
  const row = db.prepare(`SELECT * FROM decisions WHERE id = ?`).get(id) as
    | DecisionRow
    | undefined;
  return row ? toDecision(row) : null;
}

export function latestDecision(db: DB, positionId: string): GuardianDecision | null {
  const row = db
    .prepare(`SELECT * FROM decisions WHERE position_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(positionId) as DecisionRow | undefined;
  return row ? toDecision(row) : null;
}

/**
 * Most recent decision the user actively rejected, within `withinMs`.
 *
 * Used to stop the pipeline re-proposing something the user just declined. A
 * rejection is an instruction, not a one-off dismissal: without this the next
 * cycle raises an equivalent decision a few seconds later and the approval
 * dialog reappears indefinitely.
 */
export function recentlyRejectedDecision(
  db: DB,
  positionId: string,
  withinMs: number,
  now = Date.now(),
): GuardianDecision | null {
  const row = db
    .prepare(
      `SELECT * FROM decisions
       WHERE position_id = ? AND status = 'rejected' AND resolved_at >= ?
       ORDER BY resolved_at DESC LIMIT 1`,
    )
    .get(positionId, now - withinMs) as DecisionRow | undefined;
  return row ? toDecision(row) : null;
}

export function pendingDecision(db: DB, positionId: string): GuardianDecision | null {
  const row = db
    .prepare(
      `SELECT * FROM decisions WHERE position_id = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(positionId) as DecisionRow | undefined;
  return row ? toDecision(row) : null;
}

export function setDecisionStatus(
  db: DB,
  id: string,
  status: GuardianDecision["status"],
  now = Date.now(),
): void {
  db.prepare(`UPDATE decisions SET status = ?, resolved_at = ? WHERE id = ?`).run(status, now, id);
}

/**
 * Marks any other pending decision for the position as superseded.
 * Prevents two approvals racing when the pipeline produces a fresh decision
 * while an earlier one is still awaiting the user.
 */
export function supersedePendingDecisions(
  db: DB,
  positionId: string,
  exceptId: string,
  now = Date.now(),
): number {
  return db
    .prepare(
      `UPDATE decisions SET status = 'superseded', resolved_at = ?
       WHERE position_id = ? AND status = 'pending' AND id != ?`,
    )
    .run(now, positionId, exceptId).changes;
}

/* -------------------------------------------------------- protection events */

interface EventRow {
  id: string;
  position_id: string;
  decision_id: string | null;
  created_at: number;
  action: Action;
  amount_usd: number;
  risk_before: number;
  risk_after: number | null;
  tx_hash: string | null;
  chain_event_id: number | null;
  status: ProtectionEvent["status"];
  reasoning: string;
  error: string | null;
}

const toEvent = (r: EventRow): ProtectionEvent => ({
  id: r.id,
  positionId: r.position_id,
  decisionId: r.decision_id,
  createdAt: r.created_at,
  action: r.action,
  amountUsd: r.amount_usd,
  riskBefore: r.risk_before,
  riskAfter: r.risk_after,
  txHash: r.tx_hash,
  chainEventId: r.chain_event_id,
  status: r.status,
  reasoning: r.reasoning,
  error: r.error,
});

export function saveProtectionEvent(db: DB, e: ProtectionEvent): void {
  db.prepare(
    `INSERT INTO protection_events
       (id, position_id, decision_id, created_at, action, amount_usd, risk_before, risk_after,
        tx_hash, chain_event_id, status, reasoning, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.id,
    e.positionId,
    e.decisionId ?? null,
    e.createdAt,
    e.action,
    e.amountUsd,
    e.riskBefore,
    e.riskAfter ?? null,
    e.txHash ?? null,
    e.chainEventId ?? null,
    e.status,
    e.reasoning,
    e.error ?? null,
  );
}

export function updateProtectionEvent(
  db: DB,
  id: string,
  patch: Partial<Pick<ProtectionEvent, "status" | "txHash" | "riskAfter" | "chainEventId" | "error">>,
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) (sets.push("status = ?"), values.push(patch.status));
  if (patch.txHash !== undefined) (sets.push("tx_hash = ?"), values.push(patch.txHash));
  if (patch.riskAfter !== undefined) (sets.push("risk_after = ?"), values.push(patch.riskAfter));
  if (patch.chainEventId !== undefined)
    (sets.push("chain_event_id = ?"), values.push(patch.chainEventId));
  if (patch.error !== undefined) (sets.push("error = ?"), values.push(patch.error));
  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE protection_events SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function listProtectionEvents(db: DB, positionId: string, limit = 100): ProtectionEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM protection_events WHERE position_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(positionId, limit) as EventRow[];
  return rows.map(toEvent);
}

export function protectionTotals(
  db: DB,
  positionId: string,
): { count: number; totalProtectedUsd: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount_usd), 0) AS total
       FROM protection_events
       WHERE position_id = ? AND status IN ('confirmed','simulated')`,
    )
    .get(positionId) as { count: number; total: number };
  return { count: row.count, totalProtectedUsd: row.total };
}

/* ------------------------------------------------------------- activity log */

export function logActivity(
  db: DB,
  entry: Omit<ActivityEntry, "id" | "createdAt"> & { createdAt?: number },
): ActivityEntry {
  const createdAt = entry.createdAt ?? Date.now();
  const info = db
    .prepare(
      `INSERT INTO activity_log (position_id, created_at, severity, stage, message)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(entry.positionId ?? null, createdAt, entry.severity, entry.stage, entry.message);
  return {
    id: Number(info.lastInsertRowid),
    positionId: entry.positionId ?? null,
    createdAt,
    severity: entry.severity,
    stage: entry.stage,
    message: entry.message,
  };
}

export function listActivity(db: DB, positionId: string, limit = 40): ActivityEntry[] {
  const rows = db
    .prepare(
      `SELECT id, position_id AS positionId, created_at AS createdAt, severity, stage, message
       FROM activity_log WHERE position_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(positionId, limit) as ActivityEntry[];
  return rows;
}

export function pruneActivity(db: DB, keepPerPosition = 300): void {
  db.prepare(
    `DELETE FROM activity_log
     WHERE id NOT IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY position_id ORDER BY created_at DESC, id DESC) AS rn
         FROM activity_log
       ) WHERE rn <= ?
     )`,
  ).run(keepPerPosition);
}

/* --------------------------------------------------------- injected events */

interface InjectedRow {
  id: string;
  position_id: string;
  kind: InjectedEvent["kind"];
  severity: number;
  created_at: number;
  expires_at: number;
  description: string;
}

const toInjected = (r: InjectedRow): InjectedEvent => ({
  id: r.id,
  positionId: r.position_id,
  kind: r.kind,
  severity: r.severity,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  description: r.description,
});

export function injectEvent(
  db: DB,
  input: {
    positionId: string;
    kind: InjectedEvent["kind"];
    severity: number;
    durationMs: number;
    description: string;
  },
  now = Date.now(),
): InjectedEvent {
  const id = newId("evt");
  db.prepare(
    `INSERT INTO injected_events (id, position_id, kind, severity, created_at, expires_at, description)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.positionId,
    input.kind,
    input.severity,
    now,
    now + input.durationMs,
    input.description,
  );
  return {
    id,
    positionId: input.positionId,
    kind: input.kind,
    severity: input.severity,
    createdAt: now,
    expiresAt: now + input.durationMs,
    description: input.description,
  };
}

export function activeInjectedEvents(
  db: DB,
  positionId: string,
  now = Date.now(),
): InjectedEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM injected_events WHERE position_id = ? AND expires_at > ? ORDER BY created_at DESC`,
    )
    .all(positionId, now) as InjectedRow[];
  return rows.map(toInjected);
}

export function clearInjectedEvents(db: DB, positionId: string, now = Date.now()): number {
  return db
    .prepare(`UPDATE injected_events SET expires_at = ? WHERE position_id = ? AND expires_at > ?`)
    .run(now, positionId, now).changes;
}
