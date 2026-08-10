import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

/**
 * Encrypt secrets at rest (calendar tokens, company Gmail App Passwords).
 * Never log plaintext. Never return ciphertext decrypt results to clients.
 */
function keyBytes(): Buffer {
  const raw =
    process.env.COMPANY_EMAIL_SECRET_KEY?.trim() ||
    process.env.GOOGLE_CALENDAR_TOKEN_KEY?.trim() ||
    process.env.GOOGLE_CLIENT_SECRET?.trim() ||
    process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ||
    process.env.SMTP_PASS?.trim() ||
    "dev-insecure-secret-key";
  return createHash("sha256").update(raw).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Invalid encrypted secret payload.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyBytes(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}
