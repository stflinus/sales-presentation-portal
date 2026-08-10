import type { PresentationSession } from "@spp/shared";
import { FOLLOWUP_STATUS } from "@spp/shared";

/** Calendar appointment derived from a Presentation follow-up attribute. */
export interface CalendarAppointment {
  id: string;
  presentationId: string;
  clientName: string;
  clientEmail: string;
  representativeName: string;
  followUpAt: string;
  followUpDate: string;
  followUpTime: string;
  statusTone: "overdue" | "today" | "upcoming" | "completed";
  followUpStatus: string;
}

export type CalendarViewMode = "month" | "week" | "day";

function followUpBucket(
  iso: string | null | undefined,
): "overdue" | "today" | "upcoming" | "none" {
  if (!iso) return "none";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "none";
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const endToday = new Date(startToday);
  endToday.setDate(endToday.getDate() + 1);
  if (t < startToday.getTime()) return "overdue";
  if (t < endToday.getTime()) return "today";
  return "upcoming";
}

/**
 * CalendarService — sole scheduling facade for the app.
 * V0.1: Internal Calendar (Presentation follow-up fields).
 * V0.2: swap provider to Google Calendar without changing callers.
 */
export interface CalendarProvider {
  readonly id: "internal" | "google";
  listAppointments(sessions: PresentationSession[]): CalendarAppointment[];
}

function appointmentTone(
  session: PresentationSession,
): CalendarAppointment["statusTone"] {
  if (session.followUpStatus === FOLLOWUP_STATUS.COMPLETED) {
    return "completed";
  }
  const bucket = followUpBucket(session.followUpAt);
  if (bucket === "overdue") return "overdue";
  if (bucket === "today") return "today";
  return "upcoming";
}


/** V0.1 provider — appointments live on Presentation documents. */
export class InternalCalendarProvider implements CalendarProvider {
  readonly id = "internal" as const;

  listAppointments(sessions: PresentationSession[]): CalendarAppointment[] {
    const rows: CalendarAppointment[] = [];
    for (const s of sessions) {
      if (
        (s.followUpStatus !== FOLLOWUP_STATUS.SCHEDULED &&
          s.followUpStatus !== FOLLOWUP_STATUS.COMPLETED) ||
        !s.followUpAt
      ) {
        continue;
      }
      const at = new Date(s.followUpAt);
      if (Number.isNaN(at.getTime())) continue;
      const pad = (n: number) => String(n).padStart(2, "0");
      const followUpDate =
        s.followUpDate ||
        `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
      const followUpTime =
        s.followUpTime || `${pad(at.getHours())}:${pad(at.getMinutes())}`;
      rows.push({
        id: s.id,
        presentationId: s.id,
        clientName: s.clientName,
        clientEmail: s.clientEmail,
        representativeName: s.representativeName,
        followUpAt: s.followUpAt,
        followUpDate,
        followUpTime,
        statusTone: appointmentTone(s),
        followUpStatus: s.followUpStatus,
      });
    }
    return rows.sort(
      (a, b) =>
        new Date(a.followUpAt).getTime() - new Date(b.followUpAt).getTime(),
    );
  }
}

/**
 * V0.2 placeholder — Google Calendar provider will replace Internal.
 * Not used in Version 0.1.
 */
export class GoogleCalendarProviderStub implements CalendarProvider {
  readonly id = "google" as const;

  listAppointments(_sessions: PresentationSession[]): CalendarAppointment[] {
    throw new Error(
      "Google Calendar provider is not enabled in Version 0.1.",
    );
  }
}

let activeProvider: CalendarProvider = new InternalCalendarProvider();

export function getCalendarService(): CalendarProvider {
  return activeProvider;
}

/** Test / future wiring only. */
export function setCalendarProvider(provider: CalendarProvider): void {
  activeProvider = provider;
}

export function appointmentsFromSessions(
  sessions: PresentationSession[],
): CalendarAppointment[] {
  return getCalendarService().listAppointments(sessions);
}
