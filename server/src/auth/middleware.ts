import type { NextFunction, Request, Response } from "express";
import { AuthError, verifyToken } from "./siwe.js";
import { getDatabase } from "../db/index.js";
import { getPosition } from "../db/repositories.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      address?: string;
    }
  }
}

/** Requires a valid bearer token; attaches the authenticated address. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "authentication required" });
    return;
  }
  try {
    const payload = verifyToken(header.slice(7));
    req.address = payload.sub;
    next();
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 401;
    res.status(status).json({ error: err instanceof Error ? err.message : "unauthorised" });
  }
}

/**
 * Requires that the authenticated user owns the position named in the route.
 * Ownership is checked on every position-scoped request — never inferred from
 * a previous one.
 */
export function requirePositionOwner(req: Request, res: Response, next: NextFunction): void {
  const positionId = req.params.positionId ?? req.params.id;
  if (!positionId) {
    res.status(400).json({ error: "position id required" });
    return;
  }
  const position = getPosition(getDatabase(), positionId);
  if (!position) {
    res.status(404).json({ error: "position not found" });
    return;
  }
  if (position.ownerAddress !== req.address) {
    // Same response as "not found" so the endpoint can't be used to probe
    // which position ids exist.
    res.status(404).json({ error: "position not found" });
    return;
  }
  next();
}
