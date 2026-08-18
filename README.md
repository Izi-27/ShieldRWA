# ShieldRWA

**AI predictive risk guardian for tokenised real-world assets.**

Most RWA platforms help you buy the asset. ShieldRWA helps you survive owning it: it
watches a position continuously, scores its risk across five signal classes, explains
what it found, challenges its own recommendation against your protection policy, and
executes a bounded defensive rotation on X Layer when — and only when — that is
genuinely the right call.

```
DETECT ──▶ UNDERSTAND ──▶ DECIDE ──▶ PROTECT
signals     AI Risk        AI Risk    ProtectionExecutor
            Analyst        Guardian   → OKX DEX interface on X Layer
```

---

## Live on X Layer testnet

The protection layer is deployed and has executed real protective rotations.

| Contract | Address |
| --- | --- |
| `RWAPosition` (ERC-4626 vault) | `0x22Ccc0840cD7d96D380E06bdd7fF8AF123E1e167` |
| `ProtectionExecutor` | `0x5Ac1Ee1129B93FFfC0d2C87F7e77032988234148` |
| `RiskOracle` | `0x7F2cf8FeABC1Cc7f2eA42371Bd912D587107E69d` |
| `MockDexRouter` (swap venue) | `0xbaC5330762e788D06fb4711aabe704B9E6fCf792` |
| RWA-T3 token | `0x463E1cCE88F9dA94449D7E5fcD14b13859Af36C3` |
| USDC token (defensive asset) | `0x2B4f0D013e25FCc0d7c9d226cB2225B8cB23DFE2` |

Network: **X Layer testnet, chain ID 1952**, RPC `https://testrpc.xlayer.tech`.

### Recorded on chain

| | |
| --- | --- |
| Risk assessments anchored to `RiskOracle` | **105** |
| Protective rotations executed | **6** |
| Value protected | **9,283 RWA-T3** |
| Vault now held defensively | **92.7%** |
| Vault total assets | **9,870 RWA-T3** |

The vault reaching 92.7% defensive is the system working: six separate risk events each
produced a bounded rotation out of the risky asset. There is no path back — ShieldRWA
only ever moves toward safety, so buying exposure back is not an action the Guardian can
take.

### Enforced by the contracts, not the backend

`ProtectionExecutor` re-checks every constraint independently, so a compromised or buggy
backend still cannot execute an unbounded swap:

- the risk assessment must be fresh (**900s** staleness window)
- the venue must be allowlisted
- a single rotation may not exceed **50%** of the position
- the swap must clear the caller's minimum output
- only `REDUCE` and `EXIT` are executable; the executor never holds funds between
  transactions

---

## Repository layout

| Directory | Stack | What it is |
| --- | --- | --- |
| [`contracts/`](contracts/) | Solidity 0.8.24, Hardhat, OpenZeppelin | `RWAPosition`, `RiskOracle`, `ProtectionExecutor`, mocks |
| [`server/`](server/) | Node.js, Express, TypeScript | Risk pipeline, AI orchestration, policy engine, chain execution, REST + WebSocket API |
| [`shieldrwa-next/`](shieldrwa-next/) | Next.js 16, React 19, TypeScript | Dashboard, policy editor, approval flow, proof log |

---

## How it works

### DETECT

Five signal classes are collected each cycle: market (volatility, deviation, drawdown,
volume), asset/issuer events, on-chain (oracle deviation, pool depth, imbalance,
staleness), portfolio (concentration, correlated exposure, defensive share), and a
predictive class derived from the direction of the other four.

Market data comes from CoinGecko, cached and shared across positions. Vault state is
read live from `RWAPosition`. Controlled events injected for demonstration are stored as
first-class rows and labelled `CONTROLLED EVENT` in the activity log — never presented as
observed data.

### UNDERSTAND — AI Risk Analyst

Scores are computed deterministically in [`risk/scoring.ts`](server/src/risk/scoring.ts):
every signal maps onto 0–100 through a documented smoothstep transform, then five classes
combine with fixed weights. The same snapshot always produces the same score, so the
number anchored on chain is reproducible from the data stored beside it.

The model contributes interpretation only — which drivers matter, what action it
recommends, and a plain-language explanation. It never invents a number.

### DECIDE — AI Risk Guardian

The Guardian challenges the Analyst. It checks the recommendation against the user's
posture and limits, weighs execution cost against modelled downside, and reduces an
over-aggressive action to the minimum effective intervention.

The policy ceiling is enforced in code by `constrain()`, not by prompt. A model asking
for a full exit gets clamped, and the clamp is visible in the decision's checks. If
slippage would exceed the loss avoided, the action is overridden to HOLD outright —
protection that costs more than the loss it prevents is not protection.

### PROTECT

`ProtectionExecutor` performs the rotation through the OKX DEX interface and records the
event with its reasoning hash, before/after risk and transaction hash. Rotations are
sized against the RWA leg the vault actually holds, not its total value.

---

## Design decisions worth knowing

**The AI is not load-bearing.** Both stages have complete deterministic implementations
and label their output `source: "deterministic"` when the model is unavailable, rate
limited, or returns anything that fails schema validation. The product is fully
functional with no API key.

**Provider-agnostic AI.** Gemini by default, Anthropic behind one env var, both through
the same `callStructured` seam. Every call is structured-output only: a response that is
truncated, refused, or schema-invalid is a clean failure the caller falls back from,
never prose the pipeline has to guess at.

**Request budgeting.** A process-wide token bucket caps AI calls across all positions,
and a provider 429 parks further calls until the retry window it names has passed.
Narration is gated on material change rather than issued every cycle, so a calm position
makes no model calls after its first assessment.

**Honest degradation.** The status bar states the running configuration rather than
implying more than it delivers:

| Not configured | Behaviour |
| --- | --- |
| Chain RPC | Protective actions recorded as `simulated`; no anchoring |
| Guardian signing key | Chain reads work; no writes |
| AI provider key | Analyst and Guardian run deterministically, and say so |
| Live market feed | Signals report `source: "simulated"` |

If the live market feed fails mid-run it serves the last known window and stops claiming
the data is live.

---

## Security posture

- **Wallet auth** — single-use, short-lived nonces; the signed message binds domain,
  chain and issue time. Ownership is re-checked on every position-scoped request and on
  every WebSocket subscribe. Unknown positions return 404 rather than 403, so the API
  cannot be used to enumerate ids.
- **Least privilege on chain** — the backend signer holds only `GUARDIAN_ROLE` and
  `REPORTER_ROLE`. It cannot mint, pause, drain, or re-point the swap venue.
- **Serialised chain writes** — one signer, one queue, so concurrent cycles cannot race
  each other's nonce.
- **The model is never trusted with the ceiling** — enforced in `constrain()`, then
  independently re-checked by the executor on chain.
- **Secrets never enter the repository** — `.env` files are gitignored at every level.

---

## Tests

```bash
cd contracts && npm test     # 16 — vault accounting, oracle, executor guards
cd server    && npm test     # 104 — scoring, policy, Guardian overrides, provider seam,
                             #       request budget, repositories, API
```

**120 tests.** The API suite drives the whole loop over HTTP: sign in with a real
signature, register a position, inject a controlled event, watch the score escalate,
receive the Guardian's clamped decision, approve it, and read it back from the proof log.

Contract tests cover the happy path plus every guard — stale assessment, unallowlisted
router, oversized rotation, slippage breach, unsupported action, wrong role.

---

## Running locally

```bash
# backend — http://localhost:4000
cd server && cp .env.example .env && npm install && npm run dev

# frontend — http://localhost:3000
cd shieldrwa-next && npm install && npm run dev
```

The stack runs end to end with no chain and no API key; anything that would have touched
the chain is recorded as `simulated` rather than pretending to have settled.

Connect a wallet, register a position, then press **TRIGGER RISK EVENT** on the dashboard
to drive a full loop.

To confirm an AI provider actually satisfies the pipeline's structured-output
requirements before relying on it:

```bash
cd server && npm run verify:ai
```

It runs a real stressed scenario through both AI stages and reports whether each returned
live, schema-valid output — or the upstream reason it did not.
