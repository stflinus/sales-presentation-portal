import { describe, expect, it } from "vitest";
import {
  ACCESS_POLICY,
  accessPolicySummary,
  clampAccessDurationDays,
  normalizeAccessPolicy,
} from "../../packages/shared/src/accessPolicy";
import {
  sessionIsExpired,
  sessionSingleViewBlocked,
} from "../../functions/src/lib/presentationPolicy.pure";

describe("access policy normalization", () => {
  it("defaults unknown values to single view", () => {
    expect(normalizeAccessPolicy(null)).toBe(ACCESS_POLICY.SINGLE_VIEW);
    expect(normalizeAccessPolicy("")).toBe(ACCESS_POLICY.SINGLE_VIEW);
    expect(normalizeAccessPolicy("invalid")).toBe(ACCESS_POLICY.SINGLE_VIEW);
  });

  it("preserves configured policies", () => {
    expect(normalizeAccessPolicy(ACCESS_POLICY.TIME_LIMITED)).toBe(
      ACCESS_POLICY.TIME_LIMITED,
    );
    expect(normalizeAccessPolicy(ACCESS_POLICY.SINGLE_VIEW_WITH_EXPIRATION)).toBe(
      ACCESS_POLICY.SINGLE_VIEW_WITH_EXPIRATION,
    );
  });
});

describe("access duration validation", () => {
  it("clamps to minimum 1 day", () => {
    expect(clampAccessDurationDays(0)).toBe(1);
    expect(clampAccessDurationDays(-5)).toBe(1);
  });

  it("defaults invalid input to 7 days", () => {
    expect(clampAccessDurationDays("x")).toBe(7);
  });

  it("clamps to maximum 365 days", () => {
    expect(clampAccessDurationDays(500)).toBe(365);
  });
});

describe("access policy summaries", () => {
  it("describes time-limited access with day count", () => {
    expect(accessPolicySummary(ACCESS_POLICY.TIME_LIMITED, 7)).toBe("7-Day Access");
  });

  it("describes single viewing for default policy", () => {
    expect(accessPolicySummary(null)).toBe("Single Viewing");
  });
});

describe("session access enforcement", () => {
  const now = Date.parse("2026-08-17T18:00:00.000Z");

  it("blocks completed single-view sessions", () => {
    expect(
      sessionSingleViewBlocked({
        accessPolicy: ACCESS_POLICY.SINGLE_VIEW,
        status: "completed",
        viewingEntitlementConsumed: false,
      }),
    ).toBe(true);
  });

  it("allows completed time-limited sessions for replay", () => {
    expect(
      sessionSingleViewBlocked({
        accessPolicy: ACCESS_POLICY.TIME_LIMITED,
        status: "completed",
        viewingEntitlementConsumed: false,
      }),
    ).toBe(false);
  });

  it("blocks consumed entitlement for single-view with expiration", () => {
    expect(
      sessionSingleViewBlocked({
        accessPolicy: ACCESS_POLICY.SINGLE_VIEW_WITH_EXPIRATION,
        status: "in_progress",
        viewingEntitlementConsumed: true,
      }),
    ).toBe(true);
  });

  it("detects expiration from expiresAt", () => {
    expect(
      sessionIsExpired({
        expiresAt: new Date(now - 1000).toISOString(),
      }),
    ).toBe(true);
    expect(
      sessionIsExpired({
        expiresAt: new Date(now + 86400000).toISOString(),
      }),
    ).toBe(false);
  });

  it("treats missing accessPolicy as single view (backward compatible)", () => {
    expect(
      sessionSingleViewBlocked({
        status: "completed",
      }),
    ).toBe(true);
  });
});

describe("invitation snapshot immutability (conceptual)", () => {
  it("policy fields are independent of user profile after snapshot", () => {
    const userSettings = {
      activeVideoId: "video-b",
      accessPolicy: ACCESS_POLICY.SINGLE_VIEW,
      accessDurationDays: null,
    };
    const invitationSnapshot = {
      videoId: "video-a",
      accessPolicy: ACCESS_POLICY.TIME_LIMITED,
      accessDurationDays: 7,
      expiresAt: "2026-08-24T18:00:00.000Z",
    };
    expect(invitationSnapshot.videoId).not.toBe(userSettings.activeVideoId);
    expect(invitationSnapshot.accessPolicy).not.toBe(userSettings.accessPolicy);
  });
});
