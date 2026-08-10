/**
 * Backend CalendarService — sole scheduling side-effect entry point.
 * V0.1 Internal: no external provider; appointments live on Presentations.
 * V0.2: register GoogleCalendarAdapter without changing follow-up callables.
 */

export interface ScheduleFollowUpEventInput {
  uid: string;
  presentationId: string;
  clientName: string;
  scheduledAtIso: string;
  existingEventId?: string | null;
  notes?: string;
}

export interface CalendarAdapter {
  readonly id: "internal" | "google";
  upsertFollowUpEvent(
    input: ScheduleFollowUpEventInput,
  ): Promise<string | null>;
  deleteFollowUpEvent(input: {
    uid: string;
    eventId?: string | null;
  }): Promise<void>;
}

class InternalCalendarAdapter implements CalendarAdapter {
  readonly id = "internal" as const;

  async upsertFollowUpEvent(
    _input: ScheduleFollowUpEventInput,
  ): Promise<string | null> {
    // V0.1: follow-up is stored on the Presentation only.
    return null;
  }

  async deleteFollowUpEvent(_input: {
    uid: string;
    eventId?: string | null;
  }): Promise<void> {
    // V0.1: nothing external to delete.
  }
}

let adapter: CalendarAdapter = new InternalCalendarAdapter();

export function getCalendarAdapter(): CalendarAdapter {
  return adapter;
}

/** V0.2 wiring hook. */
export function setCalendarAdapter(next: CalendarAdapter): void {
  adapter = next;
}

export async function syncFollowUpCalendarEvent(
  input: ScheduleFollowUpEventInput,
): Promise<string | null> {
  return getCalendarAdapter().upsertFollowUpEvent(input);
}

export async function deleteFollowUpCalendarEvent(input: {
  uid: string;
  eventId?: string | null;
}): Promise<void> {
  return getCalendarAdapter().deleteFollowUpEvent(input);
}
