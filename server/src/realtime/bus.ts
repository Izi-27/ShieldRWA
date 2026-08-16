import { EventEmitter } from "node:events";
import type {
  ActivityEntry,
  GuardianDecision,
  ProtectionEvent,
  RiskAssessment,
  SignalSnapshot,
} from "../domain/types.js";

/**
 * In-process pub/sub between the risk pipeline and the WebSocket layer.
 * Messages are namespaced by position so a socket only receives what its
 * authenticated user is entitled to see.
 */

export type ServerMessage =
  | { type: "assessment"; positionId: string; payload: RiskAssessment }
  | { type: "snapshot"; positionId: string; payload: SignalSnapshot }
  | { type: "decision"; positionId: string; payload: GuardianDecision }
  | { type: "protection"; positionId: string; payload: ProtectionEvent }
  | { type: "activity"; positionId: string; payload: ActivityEntry }
  | { type: "stage"; positionId: string; payload: { stage: string; status: string } };

class RealtimeBus extends EventEmitter {
  publish(message: ServerMessage): void {
    this.emit("message", message);
    this.emit(`position:${message.positionId}`, message);
  }

  subscribe(positionId: string, handler: (m: ServerMessage) => void): () => void {
    this.on(`position:${positionId}`, handler);
    return () => this.off(`position:${positionId}`, handler);
  }
}

export const bus = new RealtimeBus();
// The pipeline can fan out to many sockets per position.
bus.setMaxListeners(200);
