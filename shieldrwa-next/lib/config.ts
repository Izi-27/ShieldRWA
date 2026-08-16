import type { ViewId } from "./types";

/**
 * Demo configuration — mirrors the tunable props of the original design file.
 */
export const DEMO_CONFIG = {
  /** Notional size of the protected position, in USD. */
  positionValue: 10000,
  /** Playback multiplier for the scripted risk event (0.5×–3×). */
  demoSpeed: 1,
  /** View shown on first load. */
  startView: "landing" as ViewId,
};
