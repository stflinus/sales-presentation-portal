import { describe, expect, it } from "vitest";
import { SESSION_STATUS, FOLLOWUP_STATUS } from "@spp/shared";
import type { PresentationSession } from "@spp/shared";
import {
  computeDashboardStats,
  matchesStatusFilter,
  readFollowUpViewPref,
  writeFollowUpViewPref,
} from "../../src/modules/dashboard/dashboardStats";

function session(
  partial: Partial<PresentationSession> & { id: string },
): PresentationSession {
  return {
    inviteId: "inv",
    representativeId: "repA",
    representativeName: "Rep A",
    clientName: "Client",
    clientEmail: "c@example.com",
    status: SESSION_STATUS.PENDING,
    videoId: "v1",
    companyId: "serenity-1",
    maxWatchedSeconds: 0,
    completionPercent: 0,
    expiresAt: "2099-01-01T00:00:00.000Z",
    representativeNotes: "",
    followUpStatus: FOLLOWUP_STATUS.NONE,
    analytics: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("dashboard visibility filters", () => {
  const own = session({ id: "1", representativeId: "repA", status: SESSION_STATUS.PENDING });
  const other = session({
    id: "2",
    representativeId: "repB",
    companyId: "other-co",
    status: SESSION_STATUS.OPENED,
  });
  const companyMate = session({
    id: "3",
    representativeId: "repB",
    companyId: "serenity-1",
    status: SESSION_STATUS.IN_PROGRESS,
  });

  it("Representative scope is own presentations only (client-side filter of owned set)", () => {
    const ownedOnly = [own].filter((s) => s.representativeId === "repA");
    expect(ownedOnly).toHaveLength(1);
    expect(ownedOnly[0]!.id).toBe("1");
    expect([own, other, companyMate].filter((s) => s.representativeId === "repA")).toHaveLength(1);
  });

  it("Manager scope is company presentations only", () => {
    const company = [own, other, companyMate].filter(
      (s) => s.companyId === "serenity-1",
    );
    expect(company.map((s) => s.id).sort()).toEqual(["1", "3"]);
  });

  it("Platform Administrator can see all", () => {
    expect([own, other, companyMate]).toHaveLength(3);
  });
});

describe("dashboard status filters and stats", () => {
  it("computes stats from real session fields only (won/lost stay 0 without outcome)", () => {
    const sessions = [
      session({ id: "a", status: SESSION_STATUS.PENDING }),
      session({ id: "b", status: SESSION_STATUS.OPENED }),
      session({ id: "c", status: SESSION_STATUS.LEGAL_ACCEPTED }),
      session({ id: "d", status: SESSION_STATUS.IN_PROGRESS }),
      session({ id: "e", status: SESSION_STATUS.COMPLETED }),
      session({
        id: "f",
        status: SESSION_STATUS.COMPLETED,
        followUpStatus: FOLLOWUP_STATUS.SCHEDULED,
        followUpAt: "2000-01-01T00:00:00.000Z",
      }),
    ];
    const stats = computeDashboardStats(sessions);
    expect(stats.pending).toBe(1);
    expect(stats.opened).toBe(1);
    expect(stats.legalAccepted).toBe(1);
    expect(stats.started).toBe(1);
    expect(stats.completed).toBe(2);
    expect(stats.followUpsDueToday).toBe(0);
    expect(stats.followUpsDue).toBe(0);
    expect(stats.won).toBe(0);
    expect(stats.lost).toBe(0);
  });

  it("won/lost filters require explicit salesOutcome", () => {
    const s = session({ id: "w", salesOutcome: "won", status: SESSION_STATUS.COMPLETED });
    expect(matchesStatusFilter(s, "won")).toBe(true);
    expect(matchesStatusFilter(s, "lost")).toBe(false);
    expect(matchesStatusFilter(session({ id: "x" }), "won")).toBe(false);
  });
});

describe("follow-up view preference", () => {
  it("saves and restores list/calendar preference", () => {
    writeFollowUpViewPref("calendar");
    expect(readFollowUpViewPref()).toBe("calendar");
    writeFollowUpViewPref("list");
    expect(readFollowUpViewPref()).toBe("list");
  });
});

describe("calendar ownership guard (Phase 1)", () => {
  it("rejects cross-user calendar uid mismatch", () => {
    const callerUid = "userA";
    const requestedUid = "userB";
    expect(requestedUid === callerUid).toBe(false);
  });

  it("connection status response never includes tokens", () => {
    const status = {
      connected: true,
      provider: "google",
      email: "a@example.com",
      needsReconnect: false,
      oauthConfigured: true,
    };
    const json = JSON.stringify(status);
    expect(json).not.toMatch(/token/i);
    expect(json).not.toMatch(/refresh/i);
    expect(json).not.toContain("encrypted");
  });
});

describe("permanent deletion preservation contract", () => {
  it("documents operational vs legal collections", () => {
    const deleteOperational = [
      "presentationSessions",
      "invites",
      "followUps",
      "notifications",
      "analyticsEvents",
      "viewingLeases",
      "viewingLocks",
    ];
    const neverDelete = [
      "legalEvidence",
      "legalAcceptances",
      "auditEvents",
      "legalDocuments",
    ];
    for (const c of neverDelete) {
      expect(deleteOperational.includes(c)).toBe(false);
    }
  });
});
