import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { logger } from "../logger.js";
import { verifyToken } from "../auth/siwe.js";
import { getDatabase } from "../db/index.js";
import { getPosition } from "../db/repositories.js";
import { bus, type ServerMessage } from "./bus.js";

/**
 * WebSocket transport for live pipeline updates.
 *
 * A socket authenticates with the same JWT the REST API uses and then
 * subscribes to positions it owns. Ownership is re-checked on every subscribe,
 * so a token cannot be used to watch someone else's position.
 */

interface SocketState {
  address: string | null;
  subscriptions: Map<string, () => void>;
  alive: boolean;
}

export function attachWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const states = new WeakMap<WebSocket, SocketState>();

  wss.on("connection", (socket, request) => {
    const state: SocketState = { address: null, subscriptions: new Map(), alive: true };
    states.set(socket, state);

    // A token may arrive in the query string (browsers cannot set headers on
    // a WebSocket handshake) or in a subsequent auth message.
    const url = new URL(request.url ?? "/ws", "http://localhost");
    const queryToken = url.searchParams.get("token");
    if (queryToken) authenticate(socket, state, queryToken);

    socket.on("pong", () => {
      state.alive = true;
    });

    socket.on("message", (raw) => {
      let message: { type?: string; token?: string; positionId?: string };
      try {
        message = JSON.parse(raw.toString()) as typeof message;
      } catch {
        send(socket, { type: "error", error: "malformed message" });
        return;
      }

      switch (message.type) {
        case "auth":
          if (message.token) authenticate(socket, state, message.token);
          else send(socket, { type: "error", error: "token required" });
          break;

        case "subscribe": {
          if (!state.address) {
            send(socket, { type: "error", error: "authenticate first" });
            return;
          }
          if (!message.positionId) {
            send(socket, { type: "error", error: "positionId required" });
            return;
          }
          if (state.subscriptions.has(message.positionId)) return;

          const position = getPosition(getDatabase(), message.positionId);
          if (!position || position.ownerAddress !== state.address) {
            send(socket, { type: "error", error: "position not found" });
            return;
          }

          const unsubscribe = bus.subscribe(message.positionId, (m: ServerMessage) => {
            send(socket, m);
          });
          state.subscriptions.set(message.positionId, unsubscribe);
          send(socket, { type: "subscribed", positionId: message.positionId });
          break;
        }

        case "unsubscribe": {
          if (!message.positionId) return;
          state.subscriptions.get(message.positionId)?.();
          state.subscriptions.delete(message.positionId);
          break;
        }

        case "ping":
          send(socket, { type: "pong" });
          break;

        default:
          send(socket, { type: "error", error: `unknown message type` });
      }
    });

    socket.on("close", () => {
      for (const unsubscribe of state.subscriptions.values()) unsubscribe();
      state.subscriptions.clear();
    });

    socket.on("error", (err) => {
      logger.warn({ err }, "websocket error");
    });
  });

  // Drop sockets that stop responding, so subscriptions don't leak.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const state = states.get(socket);
      if (state && !state.alive) {
        socket.terminate();
        continue;
      }
      if (state) state.alive = false;
      socket.ping();
    }
  }, 30_000);

  wss.on("close", () => clearInterval(heartbeat));

  logger.info("websocket server attached at /ws");
  return wss;
}

function authenticate(socket: WebSocket, state: SocketState, token: string): void {
  try {
    const payload = verifyToken(token);
    state.address = payload.sub;
    send(socket, { type: "authenticated", address: payload.sub });
  } catch {
    send(socket, { type: "error", error: "invalid token" });
  }
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}
