"use client";

import { API_BASE } from "./api";
import type {
  ActivityEntry,
  GuardianDecision,
  ProtectionEvent,
  RiskAssessment,
} from "./api";

/**
 * WebSocket client for live pipeline updates.
 *
 * Reconnects with exponential backoff and re-subscribes on every open, so a
 * dropped connection recovers without the caller doing anything. The caller
 * still holds the REST snapshot as the source of truth — socket messages are
 * updates, not the only path to state.
 */

export type SocketMessage =
  | { type: "assessment"; positionId: string; payload: RiskAssessment }
  | { type: "decision"; positionId: string; payload: GuardianDecision }
  | { type: "protection"; positionId: string; payload: ProtectionEvent }
  | { type: "activity"; positionId: string; payload: ActivityEntry }
  | { type: "snapshot"; positionId: string; payload: unknown };

export type SocketStatus = "connecting" | "open" | "closed";

export interface SocketHandle {
  close: () => void;
}

export function openSocket(options: {
  token: string;
  positionId: string;
  onMessage: (message: SocketMessage) => void;
  onStatus?: (status: SocketStatus) => void;
}): SocketHandle {
  const wsUrl = API_BASE.replace(/^http/, "ws").replace(/\/api$/, "") + "/ws";

  let socket: WebSocket | null = null;
  let attempt = 0;
  let closedByCaller = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closedByCaller) return;
    options.onStatus?.("connecting");

    try {
      socket = new WebSocket(`${wsUrl}?token=${encodeURIComponent(options.token)}`);
    } catch {
      scheduleRetry();
      return;
    }

    socket.onopen = () => {
      attempt = 0;
      options.onStatus?.("open");
      socket?.send(JSON.stringify({ type: "subscribe", positionId: options.positionId }));
    };

    socket.onmessage = (event) => {
      let parsed: SocketMessage & { type: string };
      try {
        parsed = JSON.parse(String(event.data)) as SocketMessage & { type: string };
      } catch {
        return;
      }
      // Control frames (authenticated / subscribed / error / pong) aren't
      // domain updates — ignore anything the caller can't use.
      if (["assessment", "decision", "protection", "activity", "snapshot"].includes(parsed.type)) {
        options.onMessage(parsed as SocketMessage);
      }
    };

    socket.onclose = () => {
      options.onStatus?.("closed");
      scheduleRetry();
    };

    socket.onerror = () => {
      socket?.close();
    };
  };

  const scheduleRetry = () => {
    if (closedByCaller) return;
    // 1s, 2s, 4s … capped at 15s.
    const delay = Math.min(15_000, 1_000 * 2 ** attempt);
    attempt++;
    retryTimer = setTimeout(connect, delay);
  };

  connect();

  return {
    close: () => {
      closedByCaller = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      socket = null;
    },
  };
}
