/**
 * @deprecated SMTP removed in Version 0.1 — use firebaseMailQueue.ts.
 * Kept as a stub so accidental imports fail closed without nodemailer.
 */
export const GMAIL_SMTP = {
  host: "removed",
  port: 0,
  encryption: "none",
} as const;

export function isSmtpConfigured(): boolean {
  return false;
}

export function classifySmtpFailure(_err: unknown): {
  status: "authentication_failed" | "connection_failed";
  message: string;
} {
  return {
    status: "connection_failed",
    message: "SMTP has been removed. Use Firebase Trigger Email (mail/).",
  };
}

export class SmtpEmailProvider {
  readonly id = "smtp";
  async sendEmail(): Promise<{ ok: false; failureReason: string }> {
    return {
      ok: false,
      failureReason:
        "SMTP has been removed. Invitation email uses Firebase Trigger Email mail queue.",
    };
  }
}
