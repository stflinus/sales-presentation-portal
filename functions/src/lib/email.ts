import { enqueueFirebaseMail } from "./notifications/firebaseMailQueue";

export interface CompletionEmailInput {
  to: string;
  clientName: string;
  completionTimeIso: string;
  sessionUrl: string;
  followUpUrl: string;
}

/** Completion emails via Firebase Trigger Email mail queue — no SMTP. */
export async function sendCompletionEmail(
  input: CompletionEmailInput,
): Promise<{ sent: boolean; reason?: string }> {
  const subject = "Client Completed Presentation";
  const text = [
    `${input.clientName} completed the presentation.`,
    "",
    `Completion time (UTC): ${input.completionTimeIso}`,
    "",
    `Client session: ${input.sessionUrl}`,
    `Schedule follow-up: ${input.followUpUrl}`,
  ].join("\n");

  const html = `
    <p><strong>${escapeHtml(input.clientName)}</strong> completed the presentation.</p>
    <p>Completion time (UTC): ${escapeHtml(input.completionTimeIso)}</p>
    <p><a href="${escapeAttr(input.sessionUrl)}">View client session</a></p>
    <p><a href="${escapeAttr(input.followUpUrl)}">Schedule follow-up</a></p>
  `;

  try {
    await enqueueFirebaseMail({
      to: [input.to],
      message: { subject, text, html },
      templateId: "completion",
    });
    return { sent: true };
  } catch (err) {
    return {
      sent: false,
      reason: err instanceof Error ? err.message : "mail_queue_failed",
    };
  }
}

/** @deprecated SMTP removed — Firebase Trigger Email is the delivery path. */
export function isSmtpConfigured(): boolean {
  return false;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
