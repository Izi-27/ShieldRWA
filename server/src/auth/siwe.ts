import jwt from "jsonwebtoken";
import { verifyMessage, isAddress, getAddress } from "viem";
import { config } from "../config.js";
import type { DB } from "../db/index.js";
import { consumeNonce, createNonce, upsertUser } from "../db/repositories.js";
import { newNonce } from "../util/id.js";

/**
 * Wallet authentication, sign-in-with-Ethereum style.
 *
 * 1. Client requests a nonce for its address.
 * 2. Client signs a structured message containing that nonce.
 * 3. Server recovers the signer, checks it matches, burns the nonce, issues a JWT.
 *
 * Nonces are single-use and short-lived, so a captured signature cannot be
 * replayed. The message binds the domain, chain and issue time so a signature
 * collected by another site is not valid here.
 */

export interface AuthTokenPayload {
  sub: string; // lowercase address
  iat: number;
  exp: number;
}

export function buildSignInMessage(input: {
  address: string;
  nonce: string;
  domain: string;
  issuedAt: string;
  chainId: number;
}): string {
  return [
    `${input.domain} wants you to sign in with your Ethereum account:`,
    getAddress(input.address),
    "",
    "Sign in to ShieldRWA to monitor and protect your tokenised RWA positions.",
    "This request will not trigger a blockchain transaction or cost any gas.",
    "",
    `URI: https://${input.domain}`,
    `Version: 1`,
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
  ].join("\n");
}

export function issueNonce(
  db: DB,
  address: string,
  domain: string,
): { nonce: string; message: string; issuedAt: string; expiresAt: number } {
  if (!isAddress(address)) throw new AuthError("invalid address");

  const nonce = newNonce();
  const issuedAt = new Date().toISOString();
  createNonce(db, nonce, address, config.auth.nonceTtlSeconds);

  return {
    nonce,
    issuedAt,
    expiresAt: Date.now() + config.auth.nonceTtlSeconds * 1_000,
    message: buildSignInMessage({
      address,
      nonce,
      domain,
      issuedAt,
      chainId: config.chain.chainId,
    }),
  };
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export async function verifySignIn(
  db: DB,
  input: { address: string; message: string; signature: string },
): Promise<{ token: string; address: string; expiresAt: number }> {
  if (!isAddress(input.address)) throw new AuthError("invalid address", 400);

  // The nonce must be present in the signed message *and* still redeemable.
  const nonceMatch = /^Nonce: (.+)$/m.exec(input.message);
  const nonce = nonceMatch?.[1]?.trim();
  if (!nonce) throw new AuthError("message is missing its nonce", 400);

  let valid = false;
  try {
    valid = await verifyMessage({
      address: getAddress(input.address),
      message: input.message,
      signature: input.signature as `0x${string}`,
    });
  } catch {
    throw new AuthError("signature could not be verified");
  }
  if (!valid) throw new AuthError("signature does not match address");

  // Burn the nonce only after the signature checks out, and treat a failed
  // burn as a replay attempt.
  if (!consumeNonce(db, nonce, input.address)) {
    throw new AuthError("nonce is unknown, expired or already used");
  }

  const address = input.address.toLowerCase();
  upsertUser(db, address);

  const expiresAt = Date.now() + config.auth.jwtTtlSeconds * 1_000;
  const token = jwt.sign({ sub: address }, config.auth.jwtSecret, {
    expiresIn: config.auth.jwtTtlSeconds,
    issuer: "shieldrwa",
  });

  return { token, address, expiresAt };
}

export function verifyToken(token: string): AuthTokenPayload {
  try {
    const decoded = jwt.verify(token, config.auth.jwtSecret, {
      issuer: "shieldrwa",
    }) as AuthTokenPayload;
    if (!decoded.sub) throw new AuthError("token has no subject");
    return decoded;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError("invalid or expired token");
  }
}
