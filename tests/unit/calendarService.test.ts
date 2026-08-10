import { describe, expect, it } from "vitest";
import { FOLLOWUP_STATUS, SESSION_STATUS } from "@spp/shared";
import type { PresentationSession } from "@spp/shared";
import {
  appointmentsFromSessions,
  InternalCalendarProvider,
} from "../../src/modules/calendar/CalendarService";

function session(
  partial: Partial<PresentationSession> & { id: string },
): PresentationSession {
  return {
    id: partial.id,
    companyId: "c1",
    representativeId: "r1",
    representativeName: "Rep",
    clientName: partial.clientName || "Client",
    clientEmail: "c@example.com",
    status: SESSION_STATUS.PENDING,
    followUpStatus: partial.followUpStatus || FOLLOWUP_STATUS.NONE,
    followUpAt: partial.followUpAt,
    followUpDate: partial.followUpDate,
    followUpTime: partial.followUpTime,
    createdAt: new Date().toISOString(),
    ...partial,
  } as PresentationSession;
}

describe("CalendarService Internal provider", () => {
  it("lists only scheduled/completed follow-ups from presentations", () => {
    const today = new Date();
    today.setHours(14, 30, 0, 0);
    const rows = appointmentsFromSessions([
      session({
        id: "a",
        clientName: "A",
        followUpStatus: FOLLOWUP_STATUS.SCHEDULED,
        followUpAt: today.toISOString(),
      }),
      session({
        id: "b",
        followUpStatus: FOLLOWUP_STATUS.NONE,
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].presentationId).toBe("a");
    expect(rows[0].statusTone).toBe("today");
  });

  it("marks completed follow-ups gray", () => {
    const provider = new InternalCalendarProvider();
    const rows = provider.listAppointments([
      session({
        id: "c",
        followUpStatus: FOLLOWUP_STATUS.COMPLETED,
        followUpAt: new Date().toISOString(),
      }),
    ]);
    expect(rows[0].statusTone).toBe("completed");
  });
});
