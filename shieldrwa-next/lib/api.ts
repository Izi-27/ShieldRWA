/**
 * Typed client for the ShieldRWA API.
 *
 * The bearer token lives in memory and in sessionStorage: it survives a page
 * reload but not a closed tab, and it is never written to localStorage where a
 * stale token could outlive the session.
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000/api";

const TOKEN_KEY = "shieldrwa.token";
const ADDRESS_KEY = "shieldrwa.address";

/* ------------------------------------------------------------------ types */

export type Action = "HOLD" | "REDUCE" | "HEDGE" | "EXIT";
export type Band = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type Posture = "Conservative" | "Balanced" | "Aggressive";
export type ProtectionMode = "AUTO" | "MANUAL";

export interface Position {
  id: string;
  ownerAddress: string;
  vaultAddress: string | null;
  assetSymbol: string;
  assetName: string;
  valueUsd: number;
  shares: string;
  status: "pending" | "active" | "closed";
  createdAt: number;
  updatedAt: number;
}

export interface ProtectionPolicy {
  positionId: string;
  posture: Posture;
  maxDrawdownBps: number;
  maxExposureBps: number;
  minLiquidityUsd: number;
  defensiveAsset: string;
  mode: ProtectionMode;
  updatedAt: number;
}

export interface ClassScores {
  market: number;
  asset: number;
  onchain: number;
  portfolio: number;
  predictive: number;
}

export interface RiskFactor {
  label: string;
  weight: number;
  severity: number;
}

export interface RiskAssessment {
  id: string;
  positionId: string;
  createdAt: number;
  compositeScore: number;
  band: Band;
  confidence: number;
  escalationProbability: number;
  recommendedAction: Action;
  classScores: ClassScores;
  factors: RiskFactor[];
  trajectory: { hour: number; score: number }[];
  reasoning: string;
  source: "ai" | "deterministic";
  anchorTxHash?: string | null;
  anchoredAt?: number | null;
}

export interface GuardianCheck {
  key: string;
  value: string;
  verdict: "pass" | "warn" | "fail" | "n/a";
}

export interface GuardianDecision {
  id: string;
  positionId: string;
  assessmentId: string;
  createdAt: number;
  proposedAction: Action;
  finalAction: Action;
  rotationBps: number;
  amountUsd: number;
  estimatedSlippageBps: number;
  modelledDownsideBps: number;
  policyMatch: string;
  rationale: string;
  checks: GuardianCheck[];
  source: "ai" | "deterministic";
  status: "pending" | "approved" | "rejected" | "executed" | "failed" | "superseded";
  resolvedAt?: number | null;
}

export interface ProtectionEvent {
  id: string;
  positionId: string;
  decisionId: string | null;
  createdAt: number;
  action: Action;
  amountUsd: number;
  riskBefore: number;
  riskAfter: number | null;
  txHash: string | null;
  status: "submitted" | "confirmed" | "failed" | "simulated";
  reasoning: string;
  error?: string | null;
  explorerUrl?: string | null;
}

export interface ActivityEntry {
  id: number;
  positionId: string | null;
  createdAt: number;
  severity: "info" | "warning" | "critical" | "success";
  stage: "DETECT" | "UNDERSTAND" | "DECIDE" | "PROTECT" | "SYSTEM";
  message: string;
}

export interface InjectedEvent {
  id: string;
  positionId: string;
  kind: "issuer" | "liquidity" | "oracle";
  severity: number;
  createdAt: number;
  expiresAt: number;
  description: string;
}

export interface PositionSnapshot {
  position: Position;
  policy: ProtectionPolicy;
  assessment: RiskAssessment | null;
  decision: GuardianDecision | null;
  activity: ActivityEntry[];
  injectedEvents: InjectedEvent[];
  totals: { count: number; totalProtectedUsd: number };
}

export interface HealthStatus {
  status: string;
  env: string;
  chain: {
    available: boolean;
    canSign: boolean;
    chainId?: number;
    blockNumber?: string;
    guardian?: string;
    error?: string;
  };
  ai: { enabled: boolean; model: string | null };
  marketData: string;
}

/* ------------------------------------------------------------- token store */

let memoryToken: string | null = null;

export function getToken(): string | null {
  if (memoryToken) return memoryToken;
  if (typeof window === "undefined") return null;
  memoryToken = window.sessionStorage.getItem(TOKEN_KEY);
  return memoryToken;
}

export function setSession(token: string, address: string): void {
  memoryToken = token;
  if (typeof window !== "undefined") {
    window.sessionStorage.setItem(TOKEN_KEY, token);
    window.sessionStorage.setItem(ADDRESS_KEY, address);
  }
}

export function getStoredAddress(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(ADDRESS_KEY);
}

export function clearSession(): void {
  memoryToken = null;
  if (typeof window !== "undefined") {
    window.sessionStorage.removeItem(TOKEN_KEY);
    window.sessionStorage.removeItem(ADDRESS_KEY);
  }
}

/* ------------------------------------------------------------------ client */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const { auth = true, headers, ...rest } = init;
  const finalHeaders = new Headers(headers);
  finalHeaders.set("Content-Type", "application/json");

  if (auth) {
    const token = getToken();
    if (token) finalHeaders.set("Authorization", `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...rest, headers: finalHeaders });
  } catch {
    throw new ApiError("Cannot reach the ShieldRWA API. Is the server running?", 0);
  }

  if (response.status === 401 && auth) {
    // The token is gone or expired — drop it so the UI returns to connect.
    clearSession();
  }

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }

  return body as T;
}

export const api = {
  health: () => request<HealthStatus>("/health", { auth: false }),

  requestNonce: (address: string) =>
    request<{ nonce: string; message: string; issuedAt: string; expiresAt: number }>(
      "/auth/nonce",
      { method: "POST", body: JSON.stringify({ address }), auth: false },
    ),

  verifySignature: (payload: { address: string; message: string; signature: string }) =>
    request<{ token: string; address: string; expiresAt: number }>("/auth/verify", {
      method: "POST",
      body: JSON.stringify(payload),
      auth: false,
    }),

  me: () => request<{ address: string; chainId: number }>("/auth/me"),

  listPositions: () => request<{ positions: Position[] }>("/positions"),

  registerPosition: (payload: {
    assetSymbol: string;
    assetName: string;
    valueUsd: number;
    vaultAddress?: string;
  }) =>
    request<{ position: Position; policy: ProtectionPolicy }>("/positions", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getPosition: (positionId: string) =>
    request<PositionSnapshot>(`/positions/${positionId}`),

  updatePolicy: (positionId: string, policy: Omit<ProtectionPolicy, "positionId" | "updatedAt">) =>
    request<{ policy: ProtectionPolicy }>(`/positions/${positionId}/policy`, {
      method: "PUT",
      body: JSON.stringify(policy),
    }),

  getHistory: (positionId: string) =>
    request<{ events: ProtectionEvent[]; totals: { count: number; totalProtectedUsd: number } }>(
      `/positions/${positionId}/history`,
    ),

  getActivity: (positionId: string) =>
    request<{ activity: ActivityEntry[] }>(`/positions/${positionId}/activity`),

  approveDecision: (positionId: string, decisionId: string) =>
    request<{ event: ProtectionEvent }>(
      `/positions/${positionId}/decision/${decisionId}/approve`,
      { method: "POST" },
    ),

  rejectDecision: (positionId: string, decisionId: string) =>
    request<{ decision: GuardianDecision }>(
      `/positions/${positionId}/decision/${decisionId}/reject`,
      { method: "POST" },
    ),

  injectEvent: (
    positionId: string,
    payload: { kind: "issuer" | "liquidity" | "oracle"; severity?: number; durationSeconds?: number },
  ) =>
    request<{ event: InjectedEvent }>(`/positions/${positionId}/events`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  clearEvents: (positionId: string) =>
    request<{ cleared: number }>(`/positions/${positionId}/events`, { method: "DELETE" }),
};
