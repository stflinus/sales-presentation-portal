import { describe, expect, it } from "vitest";
import type { Company, NotificationPlatformSettings } from "@spp/shared";
import { NOTIFICATION_PROVIDER } from "@spp/shared";

/** Mirrors functions/src/lib/notifications/invitationBranding.ts */
function resolveInvitationBranding(
  company: Company,
  platform: NotificationPlatformSettings,
) {
  const email = company.emailBranding || {};
  const branding = company.branding || {};
  const companyName =
    (company.name || "").trim() || platform.defaultSenderDisplayName;
  const displayEmailName =
    company.displayEmailName?.trim() ||
    email.senderDisplayName?.trim() ||
    branding.displayName?.trim() ||
    companyName;
  return {
    companyName,
    senderDisplayName: displayEmailName,
    replyToEmail: company.replyToEmail?.trim() || null,
  };
}

const platform: NotificationPlatformSettings = {
  defaultProvider: NOTIFICATION_PROVIDER.SMTP,
  defaultSenderDisplayName: "Presentation Hub",
  defaultInvitationSubject: "Secure Presentation Invitation",
  defaultFooter: "Delivered securely by Presentation Hub.",
};

describe("company-branded From display name", () => {
  it("uses displayEmailName when set", () => {
    const company = {
      id: "c1",
      name: "Serenity 1 Legal Entity",
      displayEmailName: "Serenity 1",
      branding: {},
      status: "active",
      createdAt: "",
      createdBy: "",
      updatedAt: "",
      activeNdaId: "",
      activeTermsId: "",
      activePrivacyId: "",
      activeVideoId: "",
      managerIds: [],
      representativeIds: [],
      defaultInviteTtlHours: 168,
    } as Company;
    const branding = resolveInvitationBranding(company, platform);
    expect(branding.senderDisplayName).toBe("Serenity 1");
  });

  it("falls back to company name — never a hardcoded vendor name", () => {
    const company = {
      id: "c2",
      name: "ABC Financial",
      branding: {},
      status: "active",
      createdAt: "",
      createdBy: "",
      updatedAt: "",
      activeNdaId: "",
      activeTermsId: "",
      activePrivacyId: "",
      activeVideoId: "",
      managerIds: [],
      representativeIds: [],
      defaultInviteTtlHours: 168,
    } as Company;
    const branding = resolveInvitationBranding(company, platform);
    expect(branding.senderDisplayName).toBe("ABC Financial");
    expect(branding.senderDisplayName).not.toBe("Presentation Hub");
  });

  it("uses company replyTo when configured", () => {
    const company = {
      id: "c3",
      name: "ABC Financial",
      replyToEmail: "reps@abc.example",
      branding: {},
      status: "active",
      createdAt: "",
      createdBy: "",
      updatedAt: "",
      activeNdaId: "",
      activeTermsId: "",
      activePrivacyId: "",
      activeVideoId: "",
      managerIds: [],
      representativeIds: [],
      defaultInviteTtlHours: 168,
    } as Company;
    expect(resolveInvitationBranding(company, platform).replyToEmail).toBe(
      "reps@abc.example",
    );
  });
});
