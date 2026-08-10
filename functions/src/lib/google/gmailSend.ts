/**
 * Gmail API send — uses the Representative's OAuth access token.
 * Never uses SMTP or Firebase Email Extension.
 */

export interface GmailSendInput {
  accessToken: string;
  to: string;
  fromEmail: string;
  fromDisplayName: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string | null;
}

export interface GmailSendResult {
  ok: boolean;
  messageId: string | null;
  failureReason: string | null;
}

function encodeSubject(subject: string): string {
  // RFC 2047 for non-ASCII; ASCII subjects pass through.
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function buildRawMime(input: GmailSendInput): string {
  const fromHeader = `${formatDisplayName(input.fromDisplayName)} <${input.fromEmail}>`;
  const lines = [
    `From: ${fromHeader}`,
    `To: ${input.to}`,
    `Subject: ${encodeSubject(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="spp_boundary"',
  ];
  if (input.replyTo?.trim()) {
    lines.push(`Reply-To: ${input.replyTo.trim()}`);
  }
  lines.push(
    "",
    "--spp_boundary",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    input.text,
    "",
    "--spp_boundary",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    input.html,
    "",
    "--spp_boundary--",
    "",
  );
  return lines.join("\r\n");
}

function formatDisplayName(name: string): string {
  const cleaned = name.replace(/[\r\n"<>]/g, "").trim() || "Presentation Hub";
  if (/^[A-Za-z0-9 .'_-]+$/.test(cleaned)) return cleaned;
  return `"${cleaned.replaceAll('"', "")}"`;
}

function toBase64Url(raw: string): string {
  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function sendGmailMessage(
  input: GmailSendInput,
): Promise<GmailSendResult> {
  const to = input.to.trim().toLowerCase();
  if (!to) {
    return { ok: false, messageId: null, failureReason: "Missing recipient." };
  }
  if (!input.accessToken) {
    return {
      ok: false,
      messageId: null,
      failureReason: "Google authorization expired. Reconnect Google.",
    };
  }

  const raw = toBase64Url(buildRawMime(input));
  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    },
  );
  const json = (await res.json()) as {
    id?: string;
    error?: { message?: string; status?: string };
  };
  if (!res.ok) {
    const msg =
      json.error?.message ||
      (res.status === 401
        ? "Google authorization expired. Reconnect Google."
        : `Gmail send failed (${res.status}).`);
    return { ok: false, messageId: null, failureReason: msg };
  }
  return {
    ok: true,
    messageId: json.id || null,
    failureReason: null,
  };
}
