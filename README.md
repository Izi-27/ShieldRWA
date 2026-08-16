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
            Analyst        Guardian   → OKX DEX on X Layer
```

## Repository layout

| Directory | Stack | What it is |
| --- | --- | --- |
| [`contracts/`](contracts/) | Solidity 0.8.24, Hardhat, OpenZeppelin | `RWAPosition` (ERC-4626 vault), `RiskOracle` (anchors assessments), `ProtectionExecutor` (executes and records protective rotations) |
| [`server/`](server/) | Node.js, Express, TypeScript | Risk pipeline, AI orchestration, policy engine, chain execution, REST + WebSocket API |
| [`shieldrwa-next/`](shieldrwa-next/) | Next.js 16, React 19, TypeScript | The dashboard, policy editor, approval flow and proof log |

## Quick start

Three terminals. The stack runs end to end with **no chain and no API key** — risk
scoring, the policy engine and the full approval flow all work, and anything that
would have touched the chain is recorded as `simulated` rather than pretending to
have settled.

```bash
# 1. Backend
cd server
cp .env.example .env          # works as-is for local development
npm install
npm run dev                   # http://localhost:4000

# 2. Frontend
cd shieldrwa-next
npm install
npm run dev                   # http://localhost:3000

# 3. Contracts (optional — only needed for real on-chain execution)
cd contracts
npm install
npm test                      # 16 tests
```

Open <http://localhost:3000>, connect a wallet, register a position, then press
**TRIGGER RISK EVENT** on the dashboard.

## What is real

| Claim | How it is satisfied |
| --- | --- |
| Real risk score from available signals | `server/src/risk/scoring.ts` — every signal maps onto 0–100 through a documented transform; the composite is reproducible from the snapshot stored beside it |
| Real AI explanation and recommendation | `server/src/ai/analyst.ts` — the model interprets the signals via structured output; scores stay deterministic so they can be verified |
| Real Guardian challenge | `server/src/ai/guardian.ts` — the model's action is clamped by `constrain()` in code, then overridden outright if execution costs more than the downside it avoids |
| Real protection-policy evaluation | `server/src/risk/policy.ts` — posture thresholds, drawdown/exposure/liquidity limits, rotation ceilings |
| Real smart-contract interaction | `contracts/` deployed to X Layer testnet; the executor enforces oracle freshness, an allowlisted venue, a rotation cap and a minimum output |
| Real transaction history with reasoning | Every protective action stores its rationale, before/after risk and transaction hash |
| Controlled demo trigger | Injected events are stored as first-class rows and labelled `CONTROLLED EVENT` in the activity log — never dressed up as observed data |

## Honest degradation

The status bar states the running configuration rather than implying more than it
delivers:

| Not configured | Behaviour |
| --- | --- |
| `CHAIN_RPC_URL` | Protective actions recorded as `simulated`; no anchoring |
| `GUARDIAN_PRIVATE_KEY` | Chain reads work; no writes |
| `GEMINI_API_KEY` (or the selected provider's key) | Analyst and Guardian use their deterministic implementations and report `source: "deterministic"` |
| `MARKET_DATA_PROVIDER=simulated` | Market signals report `source: "simulated"` |

If the live market feed fails mid-run it degrades to the last known window and stops
claiming the data is live.

## Going on-chain (X Layer testnet)

```bash
cd contracts
cp .env.example .env           # DEPLOYER_PRIVATE_KEY, GUARDIAN_ADDRESS
npm run deploy:xlayer
```

The script deploys the layer, wires `EXECUTOR_ROLE` / `GUARDIAN_ROLE` / `REPORTER_ROLE`,
allowlists the venue, and writes `contracts/deployments/xlayerTestnet.json`. The server
reads that address book at boot — set `CHAIN_RPC_URL` and `GUARDIAN_PRIVATE_KEY` in
`server/.env` and restart; the status bar flips to `CONNECTED`.

## AI provider

Gemini by default; Anthropic is a one-line switch. Both go through the same
`callStructured` seam, so the pipeline is unchanged either way and a provider
failure falls back to the deterministic implementation rather than breaking.

```bash
# server/.env
AI_PROVIDER=gemini
GEMINI_API_KEY=...            # https://aistudio.google.com/apikey
GEMINI_MODEL=gemini-3.7-flash
```

Verify before deploying — a provider that returns prose instead of schema-valid
JSON degrades silently:

```bash
cd server && npm run verify:ai
```

It runs a real stressed scenario through both AI stages and reports `source` for
each. On failure it prints the upstream error and what to do about it.

## Security posture

- **Wallet auth** — single-use, short-lived nonces; the signed message binds domain,
  chain and issue time. Ownership is re-checked on every position-scoped request and
  on every WebSocket subscribe.
- **Least privilege on chain** — the backend signer holds only `GUARDIAN_ROLE` and
  `REPORTER_ROLE`. It cannot mint, pause or drain; the executor never holds funds
  between transactions.
- **The model is never trusted with the ceiling** — the policy limit is enforced in
  `constrain()`, not in the prompt. A model asking for a full exit gets clamped, and
  the clamp is visible in the decision's checks.
- **Defence in depth on execution** — `ProtectionExecutor` independently re-checks
  oracle freshness, the venue allowlist, the rotation cap and the minimum output, so a
  compromised backend still cannot execute an unbounded swap.
- **Unknown positions return 404, not 403**, so the API cannot be used to enumerate ids.

## Tests

```bash
cd contracts && npm test     # 16 — vault accounting, oracle, executor guards
cd server    && npm test     # 93 — scoring, policy, Guardian overrides, provider seam, repositories, API
```

109 tests total. The API suite drives the whole loop over HTTP: sign in, register,
inject a controlled event, watch the score escalate, receive the Guardian's clamped
decision, approve it, and read it back from the proof log.
