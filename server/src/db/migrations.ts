export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial-schema",
    up: `
      -- Wallet-authenticated investors.
      CREATE TABLE users (
        address     TEXT PRIMARY KEY,          -- lowercase 0x address
        created_at  INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );

      -- Single-use nonces for the sign-in-with-Ethereum handshake.
      CREATE TABLE auth_nonces (
        nonce       TEXT PRIMARY KEY,
        address     TEXT NOT NULL,
        issued_at   INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE INDEX idx_auth_nonces_address ON auth_nonces(address);
      CREATE INDEX idx_auth_nonces_expires ON auth_nonces(expires_at);

      -- A protected RWA exposure registered against the vault.
      CREATE TABLE positions (
        id            TEXT PRIMARY KEY,
        owner_address TEXT NOT NULL REFERENCES users(address) ON DELETE CASCADE,
        vault_address TEXT,                     -- RWAPosition vault, null until registered on chain
        asset_symbol  TEXT NOT NULL,
        asset_name    TEXT NOT NULL,
        value_usd     REAL NOT NULL,
        shares        TEXT NOT NULL DEFAULT '0',
        status        TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('pending', 'active', 'closed')),
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE INDEX idx_positions_owner ON positions(owner_address);

      -- The user's protection policy. One row per position.
      CREATE TABLE policies (
        position_id    TEXT PRIMARY KEY REFERENCES positions(id) ON DELETE CASCADE,
        posture        TEXT NOT NULL
                       CHECK (posture IN ('Conservative', 'Balanced', 'Aggressive')),
        max_drawdown_bps      INTEGER NOT NULL,
        max_exposure_bps      INTEGER NOT NULL,
        min_liquidity_usd     REAL NOT NULL,
        defensive_asset       TEXT NOT NULL,
        mode           TEXT NOT NULL CHECK (mode IN ('AUTO', 'MANUAL')),
        updated_at     INTEGER NOT NULL
      );

      -- Raw signal snapshots from the DETECT stage.
      CREATE TABLE signal_snapshots (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id   TEXT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
        captured_at   INTEGER NOT NULL,
        market_json   TEXT NOT NULL,
        asset_json    TEXT NOT NULL,
        onchain_json  TEXT NOT NULL,
        portfolio_json TEXT NOT NULL
      );
      CREATE INDEX idx_signals_position_time ON signal_snapshots(position_id, captured_at DESC);

      -- Scored assessments from the UNDERSTAND stage.
      CREATE TABLE assessments (
        id             TEXT PRIMARY KEY,
        position_id    TEXT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
        created_at     INTEGER NOT NULL,
        composite_score REAL NOT NULL,
        band           TEXT NOT NULL CHECK (band IN ('LOW','MEDIUM','HIGH','CRITICAL')),
        confidence     REAL NOT NULL,
        escalation_probability REAL NOT NULL,
        recommended_action TEXT NOT NULL
                       CHECK (recommended_action IN ('HOLD','REDUCE','HEDGE','EXIT')),
        class_scores_json TEXT NOT NULL,
        factors_json   TEXT NOT NULL,
        trajectory_json TEXT NOT NULL,
        reasoning      TEXT NOT NULL,
        source         TEXT NOT NULL CHECK (source IN ('ai', 'deterministic')),
        anchor_tx_hash TEXT,
        anchored_at    INTEGER
      );
      CREATE INDEX idx_assessments_position_time ON assessments(position_id, created_at DESC);

      -- Guardian verdicts from the DECIDE stage.
      CREATE TABLE decisions (
        id              TEXT PRIMARY KEY,
        position_id     TEXT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
        assessment_id   TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
        created_at      INTEGER NOT NULL,
        proposed_action TEXT NOT NULL CHECK (proposed_action IN ('HOLD','REDUCE','HEDGE','EXIT')),
        final_action    TEXT NOT NULL CHECK (final_action IN ('HOLD','REDUCE','HEDGE','EXIT')),
        rotation_bps    INTEGER NOT NULL DEFAULT 0,
        amount_usd      REAL NOT NULL DEFAULT 0,
        estimated_slippage_bps INTEGER NOT NULL DEFAULT 0,
        modelled_downside_bps  INTEGER NOT NULL DEFAULT 0,
        policy_match    TEXT NOT NULL,
        rationale       TEXT NOT NULL,
        checks_json     TEXT NOT NULL,
        source          TEXT NOT NULL CHECK (source IN ('ai', 'deterministic')),
        status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','rejected','executed','failed','superseded')),
        resolved_at     INTEGER
      );
      CREATE INDEX idx_decisions_position_status ON decisions(position_id, status);
      CREATE INDEX idx_decisions_created ON decisions(created_at DESC);

      -- Executed protective actions from the PROTECT stage.
      CREATE TABLE protection_events (
        id             TEXT PRIMARY KEY,
        position_id    TEXT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
        decision_id    TEXT REFERENCES decisions(id) ON DELETE SET NULL,
        created_at     INTEGER NOT NULL,
        action         TEXT NOT NULL CHECK (action IN ('HOLD','REDUCE','HEDGE','EXIT')),
        amount_usd     REAL NOT NULL,
        risk_before    REAL NOT NULL,
        risk_after     REAL,
        tx_hash        TEXT,
        chain_event_id INTEGER,
        status         TEXT NOT NULL
                       CHECK (status IN ('submitted','confirmed','failed','simulated')),
        reasoning      TEXT NOT NULL,
        error          TEXT
      );
      CREATE INDEX idx_events_position_time ON protection_events(position_id, created_at DESC);

      -- Append-only operational feed shown in the dashboard.
      CREATE TABLE activity_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id TEXT REFERENCES positions(id) ON DELETE CASCADE,
        created_at  INTEGER NOT NULL,
        severity    TEXT NOT NULL CHECK (severity IN ('info','warning','critical','success')),
        stage       TEXT NOT NULL CHECK (stage IN ('DETECT','UNDERSTAND','DECIDE','PROTECT','SYSTEM')),
        message     TEXT NOT NULL
      );
      CREATE INDEX idx_activity_position_time ON activity_log(position_id, created_at DESC);
    `,
  },
  {
    version: 2,
    name: "controlled-risk-events",
    up: `
      -- Controlled issuer/liquidity/oracle events, per the spec's demo trigger.
      -- Kept as first-class rows so the dashboard can be honest about which
      -- signals were injected versus observed.
      CREATE TABLE injected_events (
        id          TEXT PRIMARY KEY,
        position_id TEXT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL CHECK (kind IN ('issuer','liquidity','oracle')),
        severity    REAL NOT NULL,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        description TEXT NOT NULL
      );
      CREATE INDEX idx_injected_position_active ON injected_events(position_id, expires_at DESC);
    `,
  },
];
