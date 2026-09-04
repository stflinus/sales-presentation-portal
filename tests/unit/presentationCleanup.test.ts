import { describe, expect, it } from "vitest";
import {
  PRESENTATION_INACTIVITY_CLEANUP_MS,
  SESSION_STATUS,
} from "../../packages/shared/src";
import {
  evaluatePresentationCleanupEligibility,
  resolveLastMeaningfulClientActivityAt,
  shouldPostponeCleanupForActiveLease,
} from "../../functions/src/lib/presentationCleanup.pure";

describe("resolveLastMeaningfulClientActivityAt", () => {
  it("prefers explicit lastMeaningfulClientActivityAt", () => {
    const iso = resolveLastMeaningfulClientActivityAt({
      lastMeaningfulClientActivityAt: "2026-09-01T12:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
      openedAt: "2026-08-15T00:00:00.000Z",
    });
    expect(iso).toBe("2026-09-01T12:00:00.000Z");
  });

  it("uses creation/sent when never opened", () => {
    const iso = resolveLastMeaningfulClientActivityAt({
      createdAt: "2026-08-20T10:00:00.000Z",
      sentAt: "2026-08-20T11:00:00.000Z",
    });
    expect(iso).toBe("2026-08-20T11:00:00.000Z");
  });

  it("reconstructs from historical client events", () => {
    const iso = resolveLastMeaningfulClientActivityAt({
      createdAt: "2026-08-01T00:00:00.000Z",
      openedAt: "2026-08-02T00:00:00.000Z",
      authorizedAt: "2026-08-02T00:01:00.000Z",
      completedAt: "2026-08-03T12:00:00.000Z",
    });
    expect(iso).toBe("2026-08-03T12:00:00.000Z");
  });
});

describe("evaluatePresentationCleanupEligibility", () => {
  const nowMs = new Date("2026-09-04T12:00:00.000Z").getTime();

  it("is eligible when invitation expired even if recently active", () => {
    const r = evaluatePresentationCleanupEligibility({
      expiresAt: "2026-09-01T00:00:00.000Z",
      lastMeaningfulClientActivityAt: "2026-09-03T12:00:00.000Z",
      createdAt: "2026-08-25T00:00:00.000Z",
      nowMs,
    });
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe("invitation_expired");
  });

  it("is eligible after 7 consecutive days without client activity", () => {
    const last = new Date(nowMs - PRESENTATION_INACTIVITY_CLEANUP_MS).toISOString();
    const r = evaluatePresentationCleanupEligibility({
      expiresAt: "2026-12-01T00:00:00.000Z",
      lastMeaningfulClientActivityAt: last,
      createdAt: "2026-08-01T00:00:00.000Z",
      nowMs,
    });
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe("client_inactivity");
  });

  it("is not eligible when within access window and recently active", () => {
    const r = evaluatePresentationCleanupEligibility({
      expiresAt: "2026-12-01T00:00:00.000Z",
      lastMeaningfulClientActivityAt: "2026-09-03T12:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
      nowMs,
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBeNull();
  });

  it("treats never-opened invite as inactive from createdAt", () => {
    const r = evaluatePresentationCleanupEligibility({
      expiresAt: "2026-12-01T00:00:00.000Z",
      createdAt: "2026-08-20T00:00:00.000Z",
      nowMs,
    });
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe("client_inactivity");
  });

  it("treats EXPIRED status as invitation_expired", () => {
    const r = evaluatePresentationCleanupEligibility({
      status: SESSION_STATUS.EXPIRED,
      expiresAt: "2026-12-01T00:00:00.000Z",
      lastMeaningfulClientActivityAt: "2026-09-03T12:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
      nowMs,
    });
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe("invitation_expired");
  });
});

describe("shouldPostponeCleanupForActiveLease", () => {
  const nowMs = new Date("2026-09-04T12:00:00.000Z").getTime();

  it("postpones when lease is active and not expired", () => {
    expect(
      shouldPostponeCleanupForActiveLease({
        leaseStatus: "active",
        leaseExpiresAt: "2026-09-04T12:01:00.000Z",
        nowMs,
      }),
    ).toBe(true);
  });

  it("does not postpone when lease expired", () => {
    expect(
      shouldPostponeCleanupForActiveLease({
        leaseStatus: "active",
        leaseExpiresAt: "2026-09-04T11:59:00.000Z",
        nowMs,
      }),
    ).toBe(false);
  });
});
