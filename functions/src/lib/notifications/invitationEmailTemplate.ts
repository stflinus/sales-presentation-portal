export interface InvitationEmailContentInput {
  clientName: string;
  companyName: string;
  representativeName?: string;
  secureLink: string;
  primaryColor?: string | null;
  logoUrl?: string | null;
  footerText?: string | null;
  subject?: string | null;
  replyToEmail?: string | null;
}

export interface InvitationEmailContent {
  subject: string;
  text: string;
  html: string;
  footer: string;
}

const DEFAULT_SUBJECT = "Secure Presentation Invitation";
const DEFAULT_FOOTER = "Delivered securely by Presentation Hub.";

export function buildInvitationEmailContent(
  input: InvitationEmailContentInput,
): InvitationEmailContent {
  const companyName = input.companyName.trim() || "Presentation Hub";
  const clientName = input.clientName.trim() || "there";
  const representativeName =
    (input.representativeName || "").trim() || "your representative";
  const link = input.secureLink.trim();
  const footer = (input.footerText || DEFAULT_FOOTER).trim() || DEFAULT_FOOTER;
  const subject =
    (input.subject || DEFAULT_SUBJECT).trim() || DEFAULT_SUBJECT;
  const color = sanitizeColor(input.primaryColor) || "#0f766e";
  const contactLine = input.replyToEmail?.trim()
    ? `Contact: ${input.replyToEmail.trim()}`
    : `Contact: ${companyName}`;

  const text = [
    `Hello ${clientName},`,
    "",
    `${representativeName} from ${companyName} has securely shared a presentation with you.`,
    "",
    "Please open the secure link below to begin:",
    link,
    "",
    "Before viewing the presentation you will review and accept:",
    "• Non-Disclosure Agreement",
    "• Terms & Conditions",
    "• Privacy Policy",
    "",
    "For security reasons this presentation may only be viewed by the intended recipient and may be limited to a single viewing.",
    "",
    contactLine,
    "",
    footer,
  ].join("\n");

  const logoBlock = input.logoUrl
    ? `<p style="margin:0 0 16px;"><img src="${escapeAttr(input.logoUrl)}" alt="${escapeHtml(companyName)}" width="160" style="max-width:160px;height:auto;border:0;" /></p>`
    : "";

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6f8;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="height:6px;background:${escapeAttr(color)};font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:28px 32px 8px;">
              ${logoBlock}
              <p style="margin:0 0 8px;font-size:22px;font-weight:bold;">${escapeHtml(companyName)}</p>
              <p style="margin:0 0 16px;font-size:18px;">Hello ${escapeHtml(clientName)},</p>
              <p style="margin:0 0 16px;font-size:16px;line-height:1.5;">
                <strong>${escapeHtml(representativeName)}</strong> from
                <strong>${escapeHtml(companyName)}</strong> has securely shared a presentation with you.
              </p>
              <p style="margin:0 0 24px;font-size:16px;line-height:1.5;">
                Please click the button below to open your secure invitation.
              </p>
              <p style="margin:0 0 24px;">
                <a href="${escapeAttr(link)}"
                   style="display:inline-block;background:${escapeAttr(color)};color:#ffffff;text-decoration:none;padding:14px 22px;border-radius:6px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;">
                  View Secure Presentation
                </a>
              </p>
              <p style="margin:0 0 8px;font-size:13px;color:#555;font-family:Arial,Helvetica,sans-serif;">
                Or open this secure URL:
              </p>
              <p style="margin:0 0 24px;font-size:13px;word-break:break-all;font-family:Arial,Helvetica,sans-serif;">
                <a href="${escapeAttr(link)}" style="color:${escapeAttr(color)};">${escapeHtml(link)}</a>
              </p>
              <p style="margin:0 0 8px;font-size:15px;line-height:1.5;">
                Before viewing the presentation you will review and accept:
              </p>
              <ul style="margin:0 0 20px;padding-left:20px;font-size:15px;line-height:1.6;">
                <li>Non-Disclosure Agreement</li>
                <li>Terms &amp; Conditions</li>
                <li>Privacy Policy</li>
              </ul>
              <p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#444;">
                For security reasons this presentation may only be viewed by the intended recipient and may be limited to a single viewing.
              </p>
              <p style="margin:16px 0 0;font-size:14px;line-height:1.5;color:#444;">
                ${escapeHtml(contactLine)}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 28px;border-top:1px solid #e8ecef;font-size:12px;color:#777;font-family:Arial,Helvetica,sans-serif;">
              ${escapeHtml(footer)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html, footer };
}

function sanitizeColor(value?: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(v) || /^#[0-9A-Fa-f]{3}$/.test(v)) return v;
  return null;
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
