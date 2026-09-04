import { describe, expect, it } from "vitest";
import {
  VIEWER_DEVICE_BLOCKED_MESSAGE,
  resolveViewerDeviceClaim,
} from "../../functions/src/lib/viewerDeviceClaim.pure";
import { deviceResetMustNotTouch } from "../../functions/src/lib/presentationPolicy.pure";

describe("resolveViewerDeviceClaim", () => {
  it("allows first claim when unbound", () => {
    expect(
      resolveViewerDeviceClaim({
        existingAuthorizedSessionId: null,
        requestCookie: null,
      }),
    ).toBe("claim");
    expect(
      resolveViewerDeviceClaim({
        existingAuthorizedSessionId: "",
        requestCookie: "anything",
      }),
    ).toBe("claim");
  });

  it("allows same cookie to resume", () => {
    expect(
      resolveViewerDeviceClaim({
        existingAuthorizedSessionId: "abc123",
        requestCookie: "abc123",
      }),
    ).toBe("same_device");
  });

  it("blocks a different device when already claimed", () => {
    expect(
      resolveViewerDeviceClaim({
        existingAuthorizedSessionId: "device-a",
        requestCookie: "device-b",
      }),
    ).toBe("blocked");
    expect(
      resolveViewerDeviceClaim({
        existingAuthorizedSessionId: "device-a",
        requestCookie: null,
      }),
    ).toBe("blocked");
  });

  it("only one winner in a simulated race (second sees existing)", () => {
    let bound: string | null = null;
    const outcomes = ["cookie-1", "cookie-2"].map((cookie) => {
      const decision = resolveViewerDeviceClaim({
        existingAuthorizedSessionId: bound,
        requestCookie: cookie,
      });
      if (decision === "claim") {
        bound = "winner-session-id";
      }
      return decision;
    });
    expect(outcomes).toEqual(["claim", "blocked"]);
    expect(bound).toBe("winner-session-id");
  });
});

describe("device-blocked copy", () => {
  it("is elderly-friendly and mentions original device / representative", () => {
    expect(VIEWER_DEVICE_BLOCKED_MESSAGE).toContain("already been opened on another device");
    expect(VIEWER_DEVICE_BLOCKED_MESSAGE).toContain("original device");
    expect(VIEWER_DEVICE_BLOCKED_MESSAGE).toContain("representative");
  });
});

describe("device reset policy isolation (unchanged without OTP)", () => {
  it("still forbids touching expiresAt and viewing entitlement", () => {
    const forbidden = deviceResetMustNotTouch();
    expect(forbidden).toContain("expiresAt");
    expect(forbidden).toContain("viewingEntitlementConsumed");
    expect(forbidden).toContain("accessPolicy");
  });
});
