import { randomBytes } from "node:crypto";

/** Prefixed, sortable-enough identifier: `asm_lq3k9x_a1b2c3d4`. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `${prefix}_${time}_${rand}`;
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}
