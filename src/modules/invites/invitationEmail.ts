/** Manual invitation email generator (does not send email). */

export const INVITATION_EMAIL_SUBJECT = "Your Secure Presentation Is Ready";

export interface InvitationEmailFields {
  clientName: string;
  clientEmail: string;
  inviteUrl: string;
  companyName?: string | null;
  representativeName: string;
  representativeTitle?: string | null;
  representativePhone?: string | null;
  representativeEmail?: string | null;
}

/** First whitespace-separated token; falls back to full name or "there". */
export function clientFirstName(fullName: string): string {
  const trimmed = fullName.trim();
  if (!trimmed) return "there";
  const first = trimmed.split(/\s+/)[0];
  return first || "there";
}

function nonEmpty(value?: string | null): string | null {
  const v = (value || "").trim();
  return v ? v : null;
}

/**
 * Build the plain-text invitation email body.
 * Omits optional signature lines when values are unavailable — no empty labels.
 */
export function buildInvitationEmailBody(fields: InvitationEmailFields): string {
  const firstName = clientFirstName(fields.clientName);
  const url = fields.inviteUrl.trim();
  const repName =
    nonEmpty(fields.representativeName) || "Your Representative";
  const title = nonEmpty(fields.representativeTitle);
  const company = nonEmpty(fields.companyName);
  const phone = nonEmpty(fields.representativePhone);
  const email = nonEmpty(fields.representativeEmail);

  const lines: string[] = [
    `Hello ${firstName},`,
    "",
    "Thank you for taking the time to meet with us today.",
    "",
    "Your secure presentation is now available for review.",
    "",
    "To begin, simply click the secure link below:",
    "",
    url,
    "",
    "If the link above is not clickable, simply copy and paste it into your web browser.",
    "",
    "If you have any questions or experience any issues accessing your presentation, please contact your representative.",
    "",
    "Thank you, and we look forward to speaking with you soon.",
    "",
    "Kind regards,",
    "",
    repName,
  ];

  if (title) lines.push(title);
  if (company) lines.push(company);
  if (phone) lines.push(`Phone: ${phone}`);
  if (email) lines.push(`Email: ${email}`);

  return lines.join("\n");
}

/** Clipboard payload: subject + blank line + body (URL already included). */
export function buildInvitationEmailCopyText(fields: InvitationEmailFields): string {
  return `Subject: ${INVITATION_EMAIL_SUBJECT}\n\n${buildInvitationEmailBody(fields)}`;
}

/** mailto: URL with TO, subject, and full body. Does not mark invitation as sent. */
export function buildInvitationMailto(fields: InvitationEmailFields): string {
  const to = fields.clientEmail.trim();
  const subject = INVITATION_EMAIL_SUBJECT;
  const body = buildInvitationEmailBody(fields);
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
