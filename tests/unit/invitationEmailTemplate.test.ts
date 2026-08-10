import { describe, expect, it } from "vitest";
import { buildInvitationEmailContent } from "../../functions/src/lib/notifications/invitationEmailTemplate";

describe("invitation email template", () => {
  it("includes required content and branding", () => {
    const content = buildInvitationEmailContent({
      clientName: "Jane Client",
      companyName: "Serenity 1",
      secureLink: "https://presentationhub.web.app/i/abc123",
      primaryColor: "#0f766e",
      footerText: "Delivered securely by Presentation Hub.",
    });

    expect(content.subject).toBe("Secure Presentation Invitation");
    expect(content.text).toContain("Hello Jane Client,");
    expect(content.text).toContain("Serenity 1 has securely shared");
    expect(content.text).toContain("https://presentationhub.web.app/i/abc123");
    expect(content.text).toContain("Non-Disclosure Agreement");
    expect(content.text).toContain("Terms & Conditions");
    expect(content.text).toContain("Privacy Policy");
    expect(content.text).toContain("Delivered securely by Presentation Hub.");
    expect(content.html).toContain("View Secure Presentation");
    expect(content.html).toContain("#0f766e");
    expect(content.html).toContain("https://presentationhub.web.app/i/abc123");
  });
});
