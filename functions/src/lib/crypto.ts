import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return sha256Hex(token);
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Deterministic audit signature over acceptance payload fields. */
export function buildAuditSignature(parts: string[]): string {
  return sha256Hex(parts.join("|"));
}
