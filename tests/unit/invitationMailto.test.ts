import { describe, expect, it } from "vitest";
import {
  INVITATION_EMAIL_SUBJECT,
  buildInvitationEmailBody,
  buildInvitationEmailCopyText,
  buildInvitationMailto,
  clientFirstName,
} from "../../src/modules/invites/invitationEmail";

const base = {
  clientName: "Jane Client",
  clientEmail: "jane@company.com",
  inviteUrl: "https://presentationhub.web.app/i/abcTokenWithSomeLength",
  companyName: "Serenity 1",
  representativeName: "Alex Rep",
  representativeTitle: "Account Executive",
  representativePhone: "+1 555 0100",
  representativeEmail: "alex@serenity.example",
};

describe("clientFirstName", () => {
  it("uses first token for first and last name", () => {
    expect(clientFirstName("Jane Client")).toBe("Jane");
  });

  it("uses only name when a single name is provided", () => {
    expect(clientFirstName("Jane")).toBe("Jane");
  });
});

describe("buildInvitationEmailBody", () => {
  it("inserts first name, URL, and full signature when fields are present", () => {
    const body = buildInvitationEmailBody(base);
    expect(body).toContain("Hello Jane,");
    expect(body).toContain(base.inviteUrl);
    expect(body).toContain("Alex Rep");
    expect(body).toContain("Account Executive");
    expect(body).toContain("Serenity 1");
    expect(body).toContain("Phone: +1 555 0100");
    expect(body).toContain("Email: alex@serenity.example");
    expect(body).not.toContain("one-time");
    expect(body).not.toContain("Firebase");
    expect(body).not.toContain("Presentation Hub");
  });

  it("omits title, phone, and email lines when unavailable", () => {
    const body = buildInvitationEmailBody({
      ...base,
      representativeTitle: null,
      representativePhone: "  ",
      representativeEmail: undefined,
    });
    expect(body).toContain("Alex Rep");
    expect(body).toContain("Serenity 1");
    expect(body).not.toContain("Account Executive");
    expect(body).not.toContain("Phone:");
    expect(body).not.toContain("Email:");
    expect(body).not.toContain("[Representative Title]");
  });

  it("omits company line when company name is empty", () => {
    const body = buildInvitationEmailBody({
      ...base,
      companyName: "",
      representativeTitle: null,
      representativePhone: null,
      representativeEmail: null,
    });
    expect(body).toContain("Alex Rep");
    expect(body).not.toContain("Serenity 1");
    expect(body).not.toContain("Presentation Hub");
  });

  it("handles a long invitation URL without dropping it", () => {
    const longUrl = `https://presentationhub.web.app/i/${"x".repeat(200)}`;
    const body = buildInvitationEmailBody({ ...base, inviteUrl: longUrl });
    expect(body).toContain(longUrl);
  });
});

describe("buildInvitationEmailCopyText", () => {
  it("prefixes Subject and includes the full body with URL", () => {
    const text = buildInvitationEmailCopyText(base);
    expect(text.startsWith(`Subject: ${INVITATION_EMAIL_SUBJECT}\n\n`)).toBe(
      true,
    );
    expect(text).toContain(base.inviteUrl);
    expect(text).toContain("Hello Jane,");
  });
});

describe("buildInvitationMailto", () => {
  it("populates recipient, exact subject, body, and secure link", () => {
    const href = buildInvitationMailto(base);
    expect(href.startsWith("mailto:jane@company.com")).toBe(true);
    expect(href).toContain(
      encodeURIComponent(INVITATION_EMAIL_SUBJECT),
    );
    expect(href).toContain(encodeURIComponent(base.inviteUrl));
    expect(href).toContain(encodeURIComponent("Hello Jane,"));
    expect(href).toContain(encodeURIComponent("Alex Rep"));
    expect(href).toContain(encodeURIComponent("Account Executive"));
    expect(href).not.toContain(encodeURIComponent("This link is unique to you."));
    expect(href).not.toContain(
      encodeURIComponent("Secure Presentation Invitation"),
    );
  });

  it("omits optional signature labels from mailto body when missing", () => {
    const href = buildInvitationMailto({
      ...base,
      representativeTitle: null,
      representativePhone: null,
      representativeEmail: null,
    });
    expect(href).not.toContain(encodeURIComponent("Phone:"));
    expect(href).not.toContain(encodeURIComponent("Email:"));
  });
});
