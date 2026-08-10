import { describe, expect, it } from "vitest";
import { buildFirebaseMailPayload } from "../../functions/src/lib/notifications/firebaseMailQueue";

describe("buildFirebaseMailPayload", () => {
  it("omits replyTo when missing", () => {
    const payload = buildFirebaseMailPayload({
      to: ["client@example.com"],
      message: {
        subject: "Secure Presentation Invitation",
        text: "Hello",
        html: "<p>Hello</p>",
      },
    });
    expect(payload).toHaveProperty("to");
    expect(payload).toHaveProperty("message");
    expect(payload).not.toHaveProperty("replyTo");
    expect(JSON.stringify(payload)).not.toContain("undefined");
  });

  it("includes replyTo only when non-empty", () => {
    const payload = buildFirebaseMailPayload({
      to: ["client@example.com"],
      message: { subject: "S", text: "t", html: "<p>h</p>" },
      replyTo: "rep@example.com",
    });
    expect(payload.replyTo).toBe("rep@example.com");
  });

  it("omits empty optional correlation fields", () => {
    const payload = buildFirebaseMailPayload({
      to: ["a@b.com"],
      message: { subject: "S", text: "t", html: "h" },
      inviteId: "",
      sessionId: undefined as unknown as string,
    });
    expect(payload).not.toHaveProperty("inviteId");
    expect(payload).not.toHaveProperty("sessionId");
    expect(payload).not.toHaveProperty("cc");
    expect(payload).not.toHaveProperty("bcc");
  });
});
