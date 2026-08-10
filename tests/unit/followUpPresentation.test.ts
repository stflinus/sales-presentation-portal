import { describe, expect, it } from "vitest";
import {
  FOLLOWUP_REMINDER_STATUS,
  FOLLOWUP_STATUS,
  type PresentationSession,
} from "@spp/shared";
import {
  computeDashboardStats,
  isFollowUpDueToday,
} from "../../src/modules/dashboard/dashboardStats";

/**
 * Architecture: follow-up is an attribute of PresentationSession.
 * Dashboard rows are presentations — never a sibling followUps entity.
 */
describe("follow-up as Presentation attribute", () => {
  const base = {
    id: "pres-1",
    inviteId: "inv-1",
    representativeId: "rep-1",
    representativeName: "Rep",
    clientName: "Client",
    clientEmail: "c@example.com",
    status: "completed" as const,
    videoId: "vid-1",
    companyId: "serenity-1",
    maxWatchedSeconds: 0,
    completionPercent: 100,
    expiresAt: new Date().toISOString(),
    representativeNotes: "",
    analytics: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("stores follow-up fields on the Presentation model", () => {
    const presentation: PresentationSession = {
      ...base,
      followUpStatus: FOLLOWUP_STATUS.SCHEDULED,
      followUpAt: "2026-08-03T18:00:00.000Z",
      followUpDate: "2026-08-03",
      followUpTime: "18:00",
      followUpCalendarEventId: null,
      followUpReminderStatus: FOLLOWUP_REMINDER_STATUS.PENDING,
      followUpNotes: "Call back",
    };
    expect(presentation.followUpDate).toBe("2026-08-03");
    expect(presentation.followUpTime).toBe("18:00");
    expect(presentation.followUpReminderStatus).toBe(
      FOLLOWUP_REMINDER_STATUS.PENDING,
    );
    expect(presentation.followUpCalendarEventId).toBeNull();
  });

  it("dashboard due count is derived from presentations, not followUps docs", () => {
    const today = new Date();
    const iso = today.toISOString();
    const sessions: PresentationSession[] = [
      {
        ...base,
        id: "a",
        followUpStatus: FOLLOWUP_STATUS.SCHEDULED,
        followUpAt: iso,
        followUpDate: iso.slice(0, 10),
        followUpTime: iso.slice(11, 16),
        followUpReminderStatus: FOLLOWUP_REMINDER_STATUS.PENDING,
      },
      {
        ...base,
        id: "b",
        followUpStatus: FOLLOWUP_STATUS.NONE,
      },
    ];
    const stats = computeDashboardStats(sessions);
    expect(stats.followUpsDueToday).toBe(
      sessions.filter((s) => isFollowUpDueToday(s)).length,
    );
    expect(stats.followUpsDueToday).toBeGreaterThanOrEqual(0);
  });

  it("reschedule identity is the Presentation id (no second operational record)", () => {
    const before: PresentationSession = {
      ...base,
      followUpStatus: FOLLOWUP_STATUS.SCHEDULED,
      followUpAt: "2026-08-01T15:00:00.000Z",
      followUpDate: "2026-08-01",
      followUpTime: "15:00",
      followUpReminderStatus: FOLLOWUP_REMINDER_STATUS.PENDING,
    };
    const after: PresentationSession = {
      ...before,
      followUpAt: "2026-08-10T16:00:00.000Z",
      followUpDate: "2026-08-10",
      followUpTime: "16:00",
    };
    expect(after.id).toBe(before.id);
    expect(after.id).toBe("pres-1");
  });
});
