import type { Company, NotificationPlatformSettings } from "../../shared";

export interface InvitationBranding {
  companyName: string;
  /** From display name — never hardcoded; from company.displayEmailName / name. */
  senderDisplayName: string;
  subject: string;
  footerText: string;
  primaryColor: string | null;
  logoUrl: string | null;
  /** Reply-To: company.replyToEmail, else company Gmail address. */
  replyToEmail: string | null;
}

/**
 * Resolve company-branded outbound email fields.
 * Display name comes from the Representative's assigned Company — never hardcoded.
 */
export function resolveInvitationBranding(
  company: Company,
  platform: NotificationPlatformSettings,
): InvitationBranding {
  const email = company.emailBranding || {};
  const branding = company.branding || {};
  const companyName =
    (company.name || "").trim() || platform.defaultSenderDisplayName;

  const displayEmailName =
    company.displayEmailName?.trim() ||
    email.senderDisplayName?.trim() ||
    branding.displayName?.trim() ||
    companyName;

  const gmail = null;
  const companyReplyTo = company.replyToEmail?.trim() || null;

  return {
    companyName,
    senderDisplayName: displayEmailName,
    subject:
      email.invitationSubject?.trim() || platform.defaultInvitationSubject,
    footerText: email.footerText?.trim() || platform.defaultFooter,
    primaryColor: email.primaryColor || branding.primaryColor || null,
    logoUrl: email.logoUrl || branding.logoUrl || null,
    replyToEmail: companyReplyTo || gmail,
  };
}
