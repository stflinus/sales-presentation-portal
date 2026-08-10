import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

describe("invitation token handling", () => {
  it("stores only hashes — raw token is not recoverable from hash", () => {
    const token = randomBytes(32).toString("base64url");
    const hash = hashToken(token);
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token);
    expect(hashToken(token)).toBe(hash);
    expect(hashToken(token + "x")).not.toBe(hash);
  });

  it("treats copied/altered tokens as different credentials", () => {
    const token = randomBytes(32).toString("base64url");
    const altered = `${token.slice(0, -1)}A`;
    expect(hashToken(altered)).not.toBe(hashToken(token));
  });
});
