"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AMBER,
  BODY,
  CREAM,
  GOLD,
  GREEN,
  MAUVE,
  MUTE,
  RED,
  ROSE,
  band,
  money,
} from "./theme";
import {
  api,
  ApiError,
  clearSession,
  getStoredAddress,
  getToken,
  setSession,
  type ActivityEntry,
  type GuardianDecision,
  type HealthStatus,
  type Position,
  type PositionSnapshot,
  type Posture,
  type ProtectionEvent,
  type ProtectionPolicy,
  type RiskAssessment,
} from "./api";
import { connectWallet, onAccountsChanged, signMessage, WalletError } from "./wallet";
import { openSocket, type SocketMessage } from "./socket";
import type { CtaCard, NavItem, SpineNode, ViewId } from "./types";

/**
 * The live application state.
 *
 * Deliberately produces the same view-model shape the design components
 * already render, so the visual layer is unchanged: what used to be a scripted
 * demo is now the server's real assessment, decision and history.
 */

const POSTURE_DESC: Record<Posture, string> = {
  Conservative: "Intervene aggressively when risk rises.",
  Balanced: "Intervene when material risk is detected.",
  Aggressive: "Tolerate more volatility before intervention.",
};

const STRIPES =
  "repeating-linear-gradient(135deg,rgba(200,162,60,0.16) 0 14px,rgba(200,162,60,0) 14px 28px)";

const SEVERITY_COLOR = {
  info: GREEN,
  success: GREEN,
  warning: GOLD,
  critical: RED,
} as const;

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export function useLiveShield() {
  const [view, setView] = useState<ViewId>("landing");
  const [address, setAddress] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("disconnected");
  const [authError, setAuthError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [policy, setPolicy] = useState<ProtectionPolicy | null>(null);
  const [assessment, setAssessment] = useState<RiskAssessment | null>(null);
  const [decision, setDecision] = useState<GuardianDecision | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [history, setHistory] = useState<ProtectionEvent[]>([]);
  const [totals, setTotals] = useState({ count: 0, totalProtectedUsd: 0 });
  const [eventActive, setEventActive] = useState(false);
  const [live, setLive] = useState(false);
  const [dismissedDecisions, setDismissedDecisions] = useState<Set<string>>(new Set());

  const socketRef = useRef<{ close: () => void } | null>(null);

  /* ------------------------------------------------------------- bootstrap */

  useEffect(() => {
    void api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  // Restore a session that survived a page reload.
  useEffect(() => {
    const token = getToken();
    const stored = getStoredAddress();
    if (!token || !stored) return;

    void (async () => {
      try {
        const me = await api.me();
        setAddress(me.address);
        setConnection("connected");
        await loadPositions();
      } catch {
        clearSession();
      }
    })();
    // Runs once on mount; loadPositions is stable via useCallback below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A wallet account switch invalidates the session — the token belongs to the
  // previous address.
  useEffect(
    () =>
      onAccountsChanged((accounts) => {
        const next = accounts[0]?.toLowerCase();
        if (!next || (address && next !== address)) {
          disconnect();
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [address],
  );

  /* ------------------------------------------------------------ data loads */

  const applySnapshot = useCallback((snapshot: PositionSnapshot) => {
    setPosition(snapshot.position);
    setPolicy(snapshot.policy);
    setAssessment(snapshot.assessment);
    setDecision(snapshot.decision);
    setActivity(snapshot.activity);
    setTotals(snapshot.totals);
    setEventActive(snapshot.injectedEvents.length > 0);
  }, []);

  const loadPosition = useCallback(
    async (positionId: string) => {
      const [snapshot, historyResult] = await Promise.all([
        api.getPosition(positionId),
        api.getHistory(positionId),
      ]);
      applySnapshot(snapshot);
      setHistory(historyResult.events);
      setTotals(historyResult.totals);
    },
    [applySnapshot],
  );

  const loadPositions = useCallback(async () => {
    const { positions } = await api.listPositions();
    const first = positions[0];
    if (first) await loadPosition(first.id);
    return first ?? null;
  }, [loadPosition]);

  /* ----------------------------------------------------------- websocket */

  useEffect(() => {
    if (!position || connection !== "connected") return;
    const token = getToken();
    if (!token) return;

    const socket = openSocket({
      token,
      positionId: position.id,
      onStatus: (status) => setLive(status === "open"),
      onMessage: (message: SocketMessage) => {
        switch (message.type) {
          case "assessment":
            setAssessment(message.payload);
            break;
          case "decision":
            setDecision(message.payload.status === "pending" ? message.payload : null);
            break;
          case "protection":
            setHistory((prev) => {
              const next = prev.filter((e) => e.id !== message.payload.id);
              return [message.payload, ...next];
            });
            // Totals only move once an action actually settles.
            if (message.payload.status === "confirmed" || message.payload.status === "simulated") {
              setTotals((t) => ({
                count: t.count + 1,
                totalProtectedUsd: t.totalProtectedUsd + message.payload.amountUsd,
              }));
            }
            break;
          case "activity":
            setActivity((prev) => [message.payload, ...prev].slice(0, 40));
            break;
        }
      },
    });
    socketRef.current = socket;
    return () => {
      socket.close();
      socketRef.current = null;
      setLive(false);
    };
  }, [position, connection]);

  /* --------------------------------------------------------------- actions */

  const connect = useCallback(async () => {
    setAuthError(null);
    setConnection("connecting");
    try {
      const account = await connectWallet();
      const { message } = await api.requestNonce(account);
      const signature = await signMessage(account, message);
      const session = await api.verifySignature({ address: account, message, signature });

      setSession(session.token, session.address);
      setAddress(session.address);
      setConnection("connected");

      const existing = await loadPositions();
      setView(existing ? "dashboard" : "onboard");
    } catch (err) {
      setConnection("error");
      setAuthError(
        err instanceof WalletError || err instanceof ApiError
          ? err.message
          : "Could not complete sign-in.",
      );
    }
  }, [loadPositions]);

  const disconnect = useCallback(() => {
    clearSession();
    socketRef.current?.close();
    setAddress(null);
    setConnection("disconnected");
    setPosition(null);
    setPolicy(null);
    setAssessment(null);
    setDecision(null);
    setActivity([]);
    setHistory([]);
    setTotals({ count: 0, totalProtectedUsd: 0 });
    setView("landing");
  }, []);

  const registerPosition = useCallback(
    async (valueUsd = 10_000) => {
      setBusy("register");
      try {
        const { position: created } = await api.registerPosition({
          assetSymbol: "RWA-T3",
          assetName: "RWA Treasury Note T3",
          valueUsd,
        });

        // Wait for the first assessment rather than guessing at a delay. The
        // opening cycle reads live vault state over RPC, so it can take a few
        // seconds — a fixed sleep either rendered an empty dashboard or stalled
        // the UI for no reason. Give up quickly either way: the WebSocket
        // delivers the assessment the moment it lands.
        const deadline = Date.now() + 6_000;
        for (;;) {
          await loadPosition(created.id);
          const ready = await api.getPosition(created.id).catch(() => null);
          if (ready?.assessment || Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 700));
        }
        return created;
      } finally {
        setBusy(null);
      }
    },
    [loadPosition],
  );

  const savePolicy = useCallback(
    async (next: Omit<ProtectionPolicy, "positionId" | "updatedAt">) => {
      if (!position) return;
      setBusy("policy");
      try {
        const { policy: saved } = await api.updatePolicy(position.id, next);
        setPolicy(saved);
      } finally {
        setBusy(null);
      }
    },
    [position],
  );

  const triggerEvent = useCallback(async () => {
    if (!position) return;
    setBusy("event");
    try {
      if (eventActive) {
        await api.clearEvents(position.id);
        setEventActive(false);
      } else {
        // A realistic compound scenario: the issuer flags a delay, the pool
        // thins, and the oracle starts to deviate.
        await Promise.all([
          api.injectEvent(position.id, { kind: "issuer", severity: 0.9, durationSeconds: 600 }),
          api.injectEvent(position.id, { kind: "liquidity", severity: 0.85, durationSeconds: 600 }),
          api.injectEvent(position.id, { kind: "oracle", severity: 0.8, durationSeconds: 600 }),
        ]);
        setEventActive(true);
      }
      await loadPosition(position.id);
    } finally {
      setBusy(null);
    }
  }, [position, eventActive, loadPosition]);

  /**
   * Decisions the user has already acted on.
   *
   * The modal must close the instant it is answered and stay closed. Clearing
   * `decision` alone is not enough: the reload that follows repopulates it from
   * the server, and the pipeline may have raised a fresh proposal in the
   * meantime — so the dialog reappeared seconds after being dismissed.
   */
  const dismissDecision = useCallback((id: string) => {
    setDismissedDecisions((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const approve = useCallback(async () => {
    if (!position || !decision) return;
    // Dismiss before awaiting. Doing it after meant a failed request — an
    // already-executed decision returning 409, say — left the dialog stuck open
    // with no way to close it.
    dismissDecision(decision.id);
    setBusy("approve");
    try {
      await api.approveDecision(position.id, decision.id);
      setDecision(null);
      await loadPosition(position.id);
    } catch (err) {
      setAuthError(err instanceof ApiError ? err.message : "Execution failed.");
    } finally {
      setBusy(null);
    }
  }, [position, decision, loadPosition, dismissDecision]);

  const reject = useCallback(async () => {
    if (!position || !decision) return;
    setBusy("reject");
    try {
      await api.rejectDecision(position.id, decision.id);
      setDecision(null);
      await loadPosition(position.id);
    } finally {
      setBusy(null);
    }
  }, [position, decision, loadPosition]);

  /* ------------------------------------------------------- derived display */

  const score = assessment?.compositeScore ?? 0;
  const b = band(score);
  const connected = connection === "connected";

  const go = useCallback((v: ViewId) => () => setView(v), []);

  const nav: NavItem[] = (
    [
      ["LANDING", "landing"],
      ["ONBOARD", "onboard"],
      ["DASHBOARD", "dashboard"],
      ["POLICY", "policy"],
      ["PROOF", "proof"],
    ] as [string, ViewId][]
  ).map(([label, id]) => ({
    label,
    id,
    go: go(id),
    ul: view === id ? MAUVE : "transparent",
    fg: view === id ? CREAM : "#9C8E8A",
  }));

  const meter = useMemo(
    () =>
      Array.from({ length: 48 }, (_, i) => {
        const at = (i + 1) * (100 / 48);
        const on = at <= score;
        return {
          h: on ? 26 + (at / 100) * 22 + "px" : "8px",
          c: on ? band(at).color : "#2A2325",
        };
      }),
    [score],
  );

  // The forecast bars render the server's predicted trajectory directly.
  const forecast = useMemo(() => {
    const path = assessment?.trajectory ?? [];
    if (path.length === 0) {
      return Array.from({ length: 26 }, () => ({ h: "3px", c: "#2A2325", o: "1" }));
    }
    return path.map((point, i) => ({
      h: Math.max(3, (point.score / 100) * 30) + "px",
      c: band(point.score).color,
      // Later points are less certain; fade them accordingly.
      o: i > path.length / 2 ? String(0.35 + (path.length - i) / (path.length * 1.6)) : "1",
    }));
  }, [assessment]);

  const signals = useMemo(() => {
    const c = assessment?.classScores;
    const rows: [string, string, number][] = [
      ["MARKET", "volatility · deviation", c?.market ?? 0],
      ["ASSET", "issuer feed", c?.asset ?? 0],
      ["ONCHAIN", "oracle · depth", c?.onchain ?? 0],
      ["PORTFOLIO", "concentration", c?.portfolio ?? 0],
      ["PREDICTIVE", "6h horizon", c?.predictive ?? 0],
    ];
    return rows.map(([label, note, value]) => ({
      label,
      note,
      value: String(Math.round(value)).padStart(2, "0"),
      color: band(value).color,
      w: Math.round(value) + "%",
    }));
  }, [assessment]);

  // The spine tracks which stage of the loop the position is actually in.
  const stage = decision
    ? 3
    : history[0] && Date.now() - history[0].createdAt < 30_000
      ? 4
      : assessment
        ? 2
        : 1;

  const spine: SpineNode[] = (
    [
      ["01", "DETECT", 1],
      ["02", "UNDERSTAND", 2],
      ["03", "DECIDE", 3],
      ["04", "PROTECT", 4],
    ] as [string, string, number][]
  ).map(([n, title, at]) => {
    const active = stage === at;
    const done = stage > at;
    return {
      n,
      title,
      status: active ? "ACTIVE" : done ? "COMPLETE" : "IDLE",
      fg: active ? CREAM : done ? BODY : "#6B5F5C",
      statusC: active ? GOLD : done ? GREEN : MUTE,
      bar: active ? GOLD : done ? MAUVE : "#241E20",
      dot: active ? GOLD : done ? GREEN : "#3B3033",
      anim: active ? "shPulse 1s steps(2,end) infinite" : "none",
    };
  });

  const analyst = {
    confidence: assessment ? `${assessment.confidence}%` : "—",
    factors: (assessment?.factors ?? []).map((f) => ({
      label: f.label,
      pct: `${Math.round(f.weight * 100)}%`,
      w: `${Math.round(f.weight * 100)}%`,
      c: band(f.severity).color,
    })),
    reasoning:
      assessment?.reasoning ??
      "Waiting for the first assessment. The Analyst scores every signal class before it says anything.",
    action: assessment?.recommendedAction ?? "—",
    source: assessment?.source ?? null,
  };

  const guardian = decision
    ? {
        fg: "#E4DAD3",
        text: decision.rationale,
        checks: decision.checks.map((c) => ({
          k: c.key,
          v: c.value,
          c:
            c.verdict === "fail"
              ? RED
              : c.verdict === "warn"
                ? GOLD
                : c.verdict === "pass"
                  ? GREEN
                  : MUTE,
        })),
        decision: decision.finalAction,
        source: decision.source,
      }
    : {
        fg: BODY,
        text: "No recommendation is pending review. The Guardian evaluates every Analyst action against your policy, the expected downside and the cost of execution before anything reaches the chain.",
        checks: [
          { k: "POLICY MATCH", v: "STANDBY", c: MUTE },
          { k: "COST VS DOWNSIDE", v: "—", c: MUTE },
          { k: "MIN. EFFECTIVE ACTION", v: "—", c: MUTE },
        ],
        decision: "HOLD",
        source: null,
      };

  const posture = policy?.posture ?? "Balanced";
  const limits = {
    drawdown: `${((policy?.maxDrawdownBps ?? 1000) / 100).toFixed(0)}%`,
    exposure: `${((policy?.maxExposureBps ?? 4000) / 100).toFixed(0)}%`,
    liquidity: formatCompactUsd(policy?.minLiquidityUsd ?? 250_000),
    stable: policy?.defensiveAsset ?? "USDC",
    mode: policy?.mode ?? "MANUAL",
  };

  const setLimit = (key: keyof typeof limits, label: string) => async () => {
    if (!policy) return;
    const next = {
      posture: policy.posture,
      maxDrawdownBps: policy.maxDrawdownBps,
      maxExposureBps: policy.maxExposureBps,
      minLiquidityUsd: policy.minLiquidityUsd,
      defensiveAsset: policy.defensiveAsset,
      mode: policy.mode,
    };
    if (key === "drawdown") next.maxDrawdownBps = Number.parseFloat(label) * 100;
    if (key === "exposure") next.maxExposureBps = Number.parseFloat(label) * 100;
    if (key === "liquidity") next.minLiquidityUsd = parseCompactUsd(label);
    if (key === "stable") next.defensiveAsset = label;
    if (key === "mode") next.mode = label as "AUTO" | "MANUAL";
    await savePolicy(next);
  };

  const mkOpt = (key: keyof typeof limits, label: string) => ({
    label,
    pick: () => void setLimit(key, label)(),
    ul: limits[key] === label ? MAUVE : "transparent",
    fg: limits[key] === label ? CREAM : "#7A6D6A",
  });

  /**
   * Builds the choices for one policy limit, always including whatever the
   * policy is currently set to.
   *
   * The server derives a position's default exposure cap from its actual
   * concentration, so it will not always land on one of the presets. Without
   * this the current value renders as unselected — and every offered option
   * sits below it, so any click would tighten the cap into an immediate breach.
   */
  const optionsFor = (key: keyof typeof limits, presets: string[]) => {
    const current = limits[key];
    const all = presets.includes(current) ? presets : [...presets, current];
    return all
      .sort((a, b) => numericValue(a) - numericValue(b))
      .map((label) => mkOpt(key, label));
  };

  const positionValue = position?.valueUsd ?? 0;
  const eventBusy = busy === "event";

  const ctaDeck: CtaCard[] = [
    {
      n: "PRIMARY",
      arrow: "→",
      size: "40px",
      rule: GOLD,
      title: "PROTECT A POSITION",
      body: "Connect, register your RWA exposure and set a posture in three steps.",
      fg: CREAM,
      go: go("onboard"),
    },
    {
      n: "SEE IT WORK",
      arrow: "◆",
      size: "28px",
      rule: MAUVE,
      title: "OPEN THE DASHBOARD",
      body: "Live risk scoring across five signal classes, with the reasoning behind every score.",
      fg: ROSE,
      go: go("dashboard"),
    },
    {
      n: "PROOF",
      arrow: "↳",
      size: "28px",
      rule: MAUVE,
      title: "READ THE RECEIPTS",
      body: "Every protective action with its reasoning and transaction hash.",
      fg: ROSE,
      go: go("proof"),
    },
  ];

  return {
    /* ----- session ----- */
    address,
    connection,
    connected,
    authError,
    busy,
    live,
    health,
    connect,
    disconnect,

    /* ----- data ----- */
    // The raw record; `position` below is the dashboard's display shape.
    positionRecord: position,
    policy,
    assessment,
    decision,
    hasPosition: Boolean(position),
    registerPosition,
    savePolicy,
    reloadPosition: () => (position ? loadPosition(position.id) : Promise.resolve()),

    /* ----- navigation ----- */
    view,
    setView,
    nav,
    isLanding: view === "landing",
    isOnboard: view === "onboard",
    isDash: view === "dashboard",
    isPolicy: view === "policy",
    isProof: view === "proof",
    goOnboard: go("onboard"),
    goDash: go("dashboard"),
    goPolicy: go("policy"),
    walletLabel: connected
      ? `◆ ${address!.slice(0, 6)}…${address!.slice(-4)}`
      : connection === "connecting"
        ? "CONNECTING…"
        : "CONNECT WALLET →",

    /* ----- landing ----- */
    ctaDeck,
    heroStats: [
      {
        k: "PROTECTED VALUE",
        v: position ? money(Math.round(positionValue)) : "—",
        c: CREAM,
      },
      { k: "PROTECTION EVENTS", v: String(totals.count).padStart(2, "0"), c: CREAM },
      {
        k: "RISK SCORE",
        v: assessment ? score.toFixed(0) : "—",
        c: assessment ? b.color : MUTE,
      },
      { k: "CAPITAL PROTECTED", v: money(Math.round(totals.totalProtectedUsd)), c: ROSE },
    ],
    loopSteps: [
      {
        n: "STEP 01",
        title: "DETECT",
        body: "Collect market, liquidity, oracle, issuer/event and portfolio signals.",
      },
      {
        n: "STEP 02",
        title: "UNDERSTAND",
        body: "The AI Risk Analyst interprets the signals and identifies the most important risk drivers.",
      },
      {
        n: "STEP 03",
        title: "DECIDE",
        body: "The AI Risk Guardian evaluates the response against your protection policy and execution constraints.",
      },
      {
        n: "STEP 04",
        title: "PROTECT",
        body: "The contract layer executes the approved defensive action on X Layer through the OKX DEX interface.",
      },
    ],
    problems: [
      {
        k: "RWA risk blindness",
        v: "Continuously monitors market, liquidity, oracle, issuer/event and portfolio signals.",
      },
      {
        k: "Reactive protection",
        v: "Uses predictive risk scoring to identify situations likely to become high-risk.",
      },
      {
        k: "No one watching",
        v: "AI Risk Guardian monitors positions continuously against user-defined protection policies.",
      },
      {
        k: "Opaque AI decisions",
        v: "Every recommendation includes risk factors, confidence, proposed action and plain-language reasoning.",
      },
      {
        k: "Manual onchain response",
        v: "ProtectionExecutor can execute defensive swaps through the OKX DEX interface.",
      },
    ],
    diffs: [
      { n: "01", t: "Protection rather than generic yield optimization." },
      { n: "02", t: "Predictive risk rather than only reporting current risk." },
      { n: "03", t: "AI reasoning rather than a simple threshold-based alert." },
      {
        n: "04",
        t: "The Guardian challenges recommendations rather than blindly executing them.",
      },
      {
        n: "05",
        t: "Your protection policy connects AI decisions to explicit investor preferences.",
      },
      {
        n: "06",
        t: "Onchain execution turns AI analysis into a measurable financial action.",
      },
    ],

    /* ----- onboarding ----- */
    stepChips: [
      {
        label: "CONNECT",
        fg: connected ? CREAM : MUTE,
        ul: connected ? MAUVE : "transparent",
      },
      {
        label: "REGISTER",
        fg: position ? CREAM : MUTE,
        ul: position ? MAUVE : "transparent",
      },
      { label: "SET POLICY", fg: policy ? CREAM : MUTE, ul: policy ? MAUVE : "transparent" },
    ],
    onboardSteps: [
      {
        n: "01",
        status: connected ? "DONE" : connection === "connecting" ? "SIGNING" : "PENDING",
        statusC: connected ? GREEN : GOLD,
        title: "CONNECT\nWALLET",
        fg: CREAM,
        titleC: connected ? ROSE : CREAM,
        rule: connected ? GREEN : MAUVE,
        body: "Sign in with your wallet. Signing proves you own the address; it does not trigger a transaction or cost gas.",
        rows: [
          { k: "NETWORK", v: health?.chain.chainId ? `CHAIN ${health.chain.chainId}` : "X LAYER TESTNET" },
          { k: "ADDRESS", v: address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—" },
        ],
        cta: connected ? "CONNECTED ✓" : "CONNECT WALLET",
        btnFg: connected ? MUTE : CREAM,
        action: connected ? () => setView("onboard") : () => void connect(),
      },
      {
        n: "02",
        status: position ? "DONE" : connected ? "READY" : "LOCKED",
        statusC: position ? GREEN : connected ? GOLD : MUTE,
        title: "REGISTER\nPOSITION",
        fg: CREAM,
        titleC: position ? ROSE : CREAM,
        rule: position ? GREEN : MAUVE,
        body: "Register the position in the ShieldRWA protection vault. RWAPosition.sol is an ERC-4626 vault representing protected exposure.",
        rows: [
          { k: "ASSET", v: position?.assetSymbol ?? "RWA-T3 TREASURY NOTE" },
          { k: "VALUE", v: position ? money(Math.round(position.valueUsd)) : money(10_000) },
          { k: "VAULT", v: "RWAPosition.sol" },
        ],
        cta: position ? "REGISTERED ✓" : busy === "register" ? "REGISTERING…" : "REGISTER POSITION",
        btnFg: position ? MUTE : CREAM,
        action: position
          ? () => setView("policy")
          : connected
            ? () => void registerPosition()
            : () => void connect(),
      },
      {
        n: "03",
        status: position ? "READY" : "LOCKED",
        statusC: position ? GOLD : MUTE,
        title: "SET\nPOLICY",
        fg: CREAM,
        titleC: CREAM,
        rule: MAUVE,
        body: "Choose the posture the Guardian enforces on your behalf, then hand the position to the protection loop.",
        rows: [
          { k: "POSTURE", v: posture.toUpperCase() },
          { k: "MAX DRAWDOWN", v: limits.drawdown },
          { k: "MODE", v: limits.mode },
        ],
        cta: "CHOOSE POLICY",
        btnFg: CREAM,
        action: go("policy"),
      },
    ],

    /* ----- dashboard ----- */
    spine,
    meter,
    forecast,
    signals,
    analyst,
    guardian,
    riskDisplay: assessment ? String(Math.round(score)).padStart(2, "0") : "--",
    bandLabel: assessment ? b.label : "AWAITING DATA",
    bandColor: assessment ? b.color : MUTE,
    riskDelta: assessment ? formatDelta(assessment) : "—",
    escalation: assessment ? `${assessment.escalationProbability}%` : "—",
    position: {
      name: position ? `${position.assetSymbol} · ${position.assetName}` : "NO POSITION REGISTERED",
      contract: position?.vaultAddress
        ? `${position.vaultAddress.slice(0, 6)}…${position.vaultAddress.slice(-4)} · ${health?.chain.available ? "X LAYER" : "OFF-CHAIN"}`
        : health?.chain.available
          ? "X LAYER"
          : "SIMULATED — NO CHAIN CONFIGURED",
      value: position ? money(Math.round(position.valueUsd)) : "—",
    },
    triggerLabel: eventBusy
      ? "WORKING…"
      : eventActive
        ? "↺ CLEAR RISK EVENT"
        : "◆ TRIGGER RISK EVENT",
    triggerBg: "none",
    triggerFg: eventActive || eventBusy ? GOLD : CREAM,
    triggerRule: eventActive || eventBusy ? GOLD : MAUVE,
    triggerStripes: eventBusy ? STRIPES : "none",
    triggerAnim: eventBusy ? "shStripes 1.1s linear infinite" : "none",
    triggerEvent: () => void triggerEvent(),

    /* ----- policy ----- */
    policyLabel: posture.toUpperCase(),
    policyDesc: POSTURE_DESC[posture],
    policySummary: [
      { k: "MAX DRAWDOWN", v: limits.drawdown },
      { k: "MAX SINGLE ASSET", v: limits.exposure },
      { k: "MIN LIQUIDITY", v: limits.liquidity },
      { k: "DEFENSIVE ASSET", v: limits.stable },
      { k: "MODE", v: limits.mode },
    ],
    postures: (["Conservative", "Balanced", "Aggressive"] as Posture[]).map((t, i) => ({
      n: "0" + (i + 1),
      title: t.toUpperCase(),
      body: POSTURE_DESC[t],
      mark: posture === t ? "◆ SELECTED" : "",
      rule: posture === t ? GOLD : "#2A2325",
      fg: posture === t ? CREAM : "#9C8E8A",
      pick: () => {
        if (!policy) return;
        void savePolicy({
          posture: t,
          maxDrawdownBps: policy.maxDrawdownBps,
          maxExposureBps: policy.maxExposureBps,
          minLiquidityUsd: policy.minLiquidityUsd,
          defensiveAsset: policy.defensiveAsset,
          mode: policy.mode,
        });
      },
    })),
    policyRows: [
      {
        label: "MAXIMUM ACCEPTABLE DRAWDOWN",
        hint: "Protection engages before the position falls past this.",
        options: optionsFor("drawdown", ["5%", "10%", "15%"]),
      },
      {
        label: "MAXIMUM SINGLE-ASSET EXPOSURE",
        hint: "Caps concentration across the protected portfolio.",
        options: optionsFor("exposure", ["40%", "60%", "80%"]),
      },
      {
        label: "MINIMUM LIQUIDITY REQUIREMENT",
        hint: "Depth below this counts as a material risk signal.",
        options: optionsFor("liquidity", ["$100K", "$250K", "$500K"]),
      },
      {
        label: "PREFERRED STABLECOIN FOR ROTATION",
        hint: "Where defensive rotations land.",
        options: ["USDC", "USDT"].map((o) => mkOpt("stable", o)),
      },
      {
        label: "PROTECTION MODE",
        hint: "Automatic execution, or approve every action yourself.",
        options: ["AUTO", "MANUAL"].map((o) => mkOpt("mode", o)),
      },
    ],
    policySentence: policy
      ? `Guardian will intervene at ${limits.drawdown} drawdown, cap any asset at ${limits.exposure}, ` +
        `require ${limits.liquidity} of depth and rotate into ${limits.stable} — ` +
        `${limits.mode === "AUTO" ? "automatically." : "with your approval."}`
      : "Register a position to configure its protection policy.",

    /* ----- decision modal ----- */
    modalOpen: Boolean(
      decision && decision.status === "pending" && !dismissedDecisions.has(decision.id),
    ),
    modal: decision
      ? {
          action: decision.finalAction,
          headline: `${(decision.rotationBps / 100).toFixed(0)}% → ${limits.stable}`,
          body: decision.rationale,
          stats: [
            { k: "AMOUNT PROTECTED", v: money(decision.amountUsd), c: CREAM },
            {
              k: "EST. SLIPPAGE",
              v: `${(decision.estimatedSlippageBps / 100).toFixed(2)}%`,
              c: GOLD,
            },
            {
              k: "MODELLED DOWNSIDE",
              v: `${(decision.modelledDownsideBps / 100).toFixed(2)}%`,
              c: RED,
            },
            {
              k: "ANALYST PROPOSED",
              v: decision.proposedAction,
              c: decision.proposedAction === decision.finalAction ? GREEN : AMBER,
            },
          ],
        }
      : null,
    approveAction: () => void approve(),
    rejectAction: () => void reject(),

    /* ----- feed and history ----- */
    feed: activity.map((a) => ({
      text: a.message,
      time: relativeTime(a.createdAt),
      c: SEVERITY_COLOR[a.severity],
    })),
    history: history.map((h) => ({
      time: new Date(h.createdAt).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
      action: h.action,
      reason: h.reasoning,
      amount: h.amountUsd > 0 ? money(h.amountUsd) : "—",
      before: Math.round(h.riskBefore),
      after: h.riskAfter !== null ? Math.round(h.riskAfter) : Math.round(h.riskBefore),
      beforeC: band(h.riskBefore).color,
      afterC: band(h.riskAfter ?? h.riskBefore).color,
      tx: h.txHash ? `${h.txHash.slice(0, 6)}…${h.txHash.slice(-4)}` : statusLabel(h.status),
      txUrl: h.explorerUrl ?? null,
      status: h.status,
    })),
    historyCount: String(totals.count).padStart(2, "0"),
    totalProtected: money(Math.round(totals.totalProtectedUsd)),
  };
}

export type LiveShieldVM = ReturnType<typeof useLiveShield>;

/* ---------------------------------------------------------------- helpers */

function statusLabel(status: ProtectionEvent["status"]): string {
  switch (status) {
    case "simulated":
      return "SIMULATED";
    case "failed":
      return "FAILED";
    case "submitted":
      return "PENDING";
    default:
      return "—";
  }
}

function formatDelta(assessment: RiskAssessment): string {
  const end = assessment.trajectory.at(-1)?.score ?? assessment.compositeScore;
  const delta = end - assessment.compositeScore;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}`;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "JUST NOW";
  if (seconds < 60) return `${String(seconds).padStart(2, "0")}S AGO`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes).padStart(2, "0")}M AGO`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}H AGO`;
}

/** Sort key for policy option labels like "65%" or "$250K". */
function numericValue(label: string): number {
  return parseCompactUsd(label.replace("%", ""));
}

function formatCompactUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(0)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function parseCompactUsd(label: string): number {
  const cleaned = label.replace(/[$,]/g, "").toUpperCase();
  if (cleaned.endsWith("M")) return Number.parseFloat(cleaned) * 1_000_000;
  if (cleaned.endsWith("K")) return Number.parseFloat(cleaned) * 1_000;
  return Number.parseFloat(cleaned);
}
