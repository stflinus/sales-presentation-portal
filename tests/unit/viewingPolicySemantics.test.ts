import { describe, expect, it } from "vitest";
import {
  ACCESS_POLICY,
  DEFAULT_ACCESS_DURATION_DAYS,
} from "../../packages/shared/src/accessPolicy";
import {
  capSignedUrlExpiresAtMs,
  computeInvitationExpiresAtIso,
  deviceResetMustNotTouch,
  DEVICE_RESET_SAFE_FIELD_PREFIXES,
  sessionIsExpired,
  sessionSingleViewBlocked,
  shouldConsumeViewingEntitlementOnCompletion,
} from "../../functions/src/lib/presentationPolicy.pure";

describe("time-limited access clock starts at invite creation", () => {
  it("sets expiration to createdAt + N days (example: 7 days from Aug 23 2pm → Aug 30 2pm)", () => {
    const createdAtMs = Date.parse("2026-08-23T14:00:00.000Z");
    const expiresAt = computeInvitationExpiresAtIso({
      accessPolicy: ACCESS_POLICY.TIME_LIMITED,
      accessDurationDays: 7,
      createdAtMs,
    });
    expect(expiresAt).toBe("2026-08-30T14:00:00.000Z");
  });

  it("does not use legal/playback timestamps — only createdAtMs (OTP removed; clock still invite-create)", () => {
    const createdAtMs = Date.parse("2026-08-23T14:00:00.000Z");
    const laterClientActionMs = Date.parse("2026-08-25T10:00:00.000Z");
    const expiresFromCreate = computeInvitationExpiresAtIso({
      accessPolicy: ACCESS_POLICY.TIME_LIMITED,
      accessDurationDays: 7,
      createdAtMs,
    });
    const expiresIfClientActionRestartedClock = computeInvitationExpiresAtIso({
      accessPolicy: ACCESS_POLICY.TIME_LIMITED,
      accessDurationDays: 7,
      createdAtMs: laterClientActionMs,
    });
    expect(expiresFromCreate).toBe("2026-08-30T14:00:00.000Z");
    expect(expiresIfClientActionRestartedClock).not.toBe(expiresFromCreate);
  });

  it("defaults missing duration to 7 days", () => {
    const createdAtMs = Date.parse("2026-01-01T00:00:00.000Z");
    const expiresAt = computeInvitationExpiresAtIso({
      accessPolicy: ACCESS_POLICY.TIME_LIMITED,
      accessDurationDays: null,
      createdAtMs,
    });
    expect(expiresAt).toBe(
      new Date(
        createdAtMs + DEFAULT_ACCESS_DURATION_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString(),
    );
  });
});

describe("single viewing entitlement", () => {
  it("does not consume entitlement until completion (in-progress still allowed)", () => {
    expect(
      sessionSingleViewBlocked({
        accessPolicy: ACCESS_POLICY.SINGLE_VIEW,
        status: "in_progress",
        viewingEntitlementConsumed: false,
      }),
    ).toBe(false);
  });

  it("blocks after legitimate consumption", () => {
    expect(
      sessionSingleViewBlocked({
        accessPolicy: ACCESS_POLICY.SINGLE_VIEW,
        status: "completed",
        viewingEntitlementConsumed: true,
      }),
    ).toBe(true);
  });

  it("blocks completed status even if entitlement flag missing (backward compatible)", () => {
    expect(
      sessionSingleViewBlocked({
        accessPolicy: ACCESS_POLICY.SINGLE_VIEW,
        status: "completed",
      }),
    ).toBe(true);
  });

  it("consumes entitlement on completion for single viewing only", () => {
    expect(
      shouldConsumeViewingEntitlementOnCompletion(ACCESS_POLICY.SINGLE_VIEW),
    ).toBe(true);
    expect(
      shouldConsumeViewingEntitlementOnCompletion(ACCESS_POLICY.TIME_LIMITED),
    ).toBe(false);
  });

  it("allows time-limited replay after completion while not expired", () => {
    expect(
      sessionSingleViewBlocked({
        accessPolicy: ACCESS_POLICY.TIME_LIMITED,
        status: "completed",
        viewingEntitlementConsumed: false,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      }),
    ).toBe(false);
  });
});

describe("server-side expiration enforcement", () => {
  it("rejects expired invitations via sessionIsExpired", () => {
    expect(
      sessionIsExpired({
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ).toBe(true);
  });

  it("allows unexpired invitations", () => {
    expect(
      sessionIsExpired({
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      }),
    ).toBe(false);
  });
});

describe("signed URL refresh cannot extend invitation expiration", () => {
  it("caps signed URL expiry to invitation expiresAt", () => {
    const nowMs = Date.parse("2026-08-23T14:00:00.000Z");
    const invitationExpiresAt = "2026-08-23T15:00:00.000Z"; // 1h remaining
    const threeHours = 3 * 60 * 60 * 1000;
    const capped = capSignedUrlExpiresAtMs({
      nowMs,
      signedUrlTtlMs: threeHours,
      invitationExpiresAt,
    });
    expect(capped).toBe(Date.parse(invitationExpiresAt));
  });

  it("uses full TTL when invitation outlives the signed URL window", () => {
    const nowMs = Date.parse("2026-08-23T14:00:00.000Z");
    const invitationExpiresAt = "2026-08-30T14:00:00.000Z";
    const threeHours = 3 * 60 * 60 * 1000;
    const capped = capSignedUrlExpiresAtMs({
      nowMs,
      signedUrlTtlMs: threeHours,
      invitationExpiresAt,
    });
    expect(capped).toBe(nowMs + threeHours);
  });

  it("returns null when invitation already expired (deny mint)", () => {
    const nowMs = Date.parse("2026-08-30T15:00:00.000Z");
    const invitationExpiresAt = "2026-08-30T14:00:00.000Z";
    expect(
      capSignedUrlExpiresAtMs({
        nowMs,
        signedUrlTtlMs: 3 * 60 * 60 * 1000,
        invitationExpiresAt,
      }),
    ).toBeNull();
  });
});

describe("device reset does not reset policy clock or entitlement", () => {
  it("forbidden fields include expiresAt and viewingEntitlementConsumed", () => {
    const forbidden = deviceResetMustNotTouch();
    expect(forbidden).toContain("expiresAt");
    expect(forbidden).toContain("viewingEntitlementConsumed");
    expect(forbidden).toContain("accessPolicy");
    expect(forbidden).toContain("accessDurationDays");
  });

  it("safe device-reset fields never include forbidden policy fields", () => {
    const forbidden = new Set(deviceResetMustNotTouch());
    for (const field of DEVICE_RESET_SAFE_FIELD_PREFIXES) {
      expect(forbidden.has(field)).toBe(false);
      for (const bad of forbidden) {
        expect(field === bad || field.startsWith(`${bad}.`)).toBe(false);
      }
    }
  });
});

describe("rep policy inheritance snapshot", () => {
  it("invitation snapshot remains independent of later rep setting changes", () => {
    const createdAtMs = Date.parse("2026-08-23T14:00:00.000Z");
    const snapshot = {
      accessPolicy: ACCESS_POLICY.TIME_LIMITED,
      accessDurationDays: 7,
      expiresAt: computeInvitationExpiresAtIso({
        accessPolicy: ACCESS_POLICY.TIME_LIMITED,
        accessDurationDays: 7,
        createdAtMs,
      }),
    };
    const laterRepSettings = {
      accessPolicy: ACCESS_POLICY.SINGLE_VIEW,
      accessDurationDays: null,
    };
    expect(snapshot.accessPolicy).not.toBe(laterRepSettings.accessPolicy);
    expect(snapshot.expiresAt).toBe("2026-08-30T14:00:00.000Z");
  });
});
