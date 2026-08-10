import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { PresentationSession } from "@spp/shared";
import {
  appointmentsFromSessions,
  type CalendarAppointment,
  type CalendarViewMode,
} from "./CalendarService";

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function monthMatrix(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = addDays(first, -((first.getDay() + 6) % 7)); // Monday-start
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) cells.push(addDays(start, i));
  return cells;
}

function weekDays(anchor: Date): Date[] {
  const day = startOfDay(anchor);
  const mondayOffset = (day.getDay() + 6) % 7;
  const monday = addDays(day, -mondayOffset);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

function formatDayLabel(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function appointmentsOnDay(
  appointments: CalendarAppointment[],
  day: Date,
): CalendarAppointment[] {
  return appointments.filter((a) => sameDay(new Date(a.followUpAt), day));
}

function toneClass(tone: CalendarAppointment["statusTone"]): string {
  return `cal-appt tone-${tone}`;
}

function AppointmentChip({ a }: { a: CalendarAppointment }) {
  return (
    <Link
      to={`/app/sessions/${a.presentationId}`}
      className={toneClass(a.statusTone)}
      title={`${a.clientName} · ${a.followUpTime}`}
    >
      <span className="cal-appt-time">{a.followUpTime}</span> {a.clientName}
    </Link>
  );
}

interface InternalCalendarPanelProps {
  sessions: PresentationSession[];
}

/**
 * Version 0.1 Internal Calendar — Monthly / Weekly / Daily agenda.
 * Data comes only through CalendarService (Presentation follow-ups).
 */
export function InternalCalendarPanel({ sessions }: InternalCalendarPanelProps) {
  const [mode, setMode] = useState<CalendarViewMode>("month");
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const appointments = useMemo(
    () => appointmentsFromSessions(sessions),
    [sessions],
  );

  const title = anchor.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  function shift(delta: number) {
    setAnchor((prev) => {
      if (mode === "month") {
        return new Date(prev.getFullYear(), prev.getMonth() + delta, 1);
      }
      if (mode === "week") return addDays(prev, delta * 7);
      return addDays(prev, delta);
    });
  }

  return (
    <div className="internal-calendar">
      <div className="section-head">
        <div>
          <h2>Calendar</h2>
          <p className="muted small" style={{ margin: 0 }}>
            Internal scheduling · Version 0.1
          </p>
        </div>
        <div className="topbar-actions">
          <button
            type="button"
            className={mode === "month" ? "" : "ghost"}
            onClick={() => setMode("month")}
          >
            Monthly
          </button>
          <button
            type="button"
            className={mode === "week" ? "" : "ghost"}
            onClick={() => setMode("week")}
          >
            Weekly
          </button>
          <button
            type="button"
            className={mode === "day" ? "" : "ghost"}
            onClick={() => setMode("day")}
          >
            Daily Agenda
          </button>
        </div>
      </div>

      <div className="cal-nav topbar-actions">
        <button type="button" className="ghost" onClick={() => shift(-1)}>
          ←
        </button>
        <strong>{mode === "day" ? formatDayLabel(anchor) : title}</strong>
        <button type="button" className="ghost" onClick={() => shift(1)}>
          →
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => setAnchor(startOfDay(new Date()))}
        >
          Today
        </button>
      </div>

      <div className="cal-legend">
        <span className="cal-legend-item tone-overdue">Overdue</span>
        <span className="cal-legend-item tone-today">Today</span>
        <span className="cal-legend-item tone-upcoming">Upcoming</span>
        <span className="cal-legend-item tone-completed">Completed</span>
      </div>

      {mode === "month" ? (
        <div className="cal-month">
          <div className="cal-month-head">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>
          <div className="cal-month-grid">
            {monthMatrix(anchor).map((day) => {
              const inMonth = day.getMonth() === anchor.getMonth();
              const items = appointmentsOnDay(appointments, day);
              return (
                <div
                  key={day.toISOString()}
                  className={`cal-cell${inMonth ? "" : " muted-cell"}${sameDay(day, new Date()) ? " today-cell" : ""}`}
                >
                  <div className="cal-cell-day">{day.getDate()}</div>
                  <div className="cal-cell-items">
                    {items.slice(0, 3).map((a) => (
                      <AppointmentChip key={a.id} a={a} />
                    ))}
                    {items.length > 3 ? (
                      <span className="muted small">+{items.length - 3}</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {mode === "week" ? (
        <div className="cal-week">
          {weekDays(anchor).map((day) => {
            const items = appointmentsOnDay(appointments, day);
            return (
              <div
                key={day.toISOString()}
                className={`cal-week-col${sameDay(day, new Date()) ? " today-cell" : ""}`}
              >
                <div className="cal-week-head">{formatDayLabel(day)}</div>
                {items.length === 0 ? (
                  <p className="muted small">No follow-ups</p>
                ) : (
                  items.map((a) => <AppointmentChip key={a.id} a={a} />)
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      {mode === "day" ? (
        <div className="cal-day-agenda">
          {appointmentsOnDay(appointments, anchor).length === 0 ? (
            <div className="empty-state">
              <p>No follow-ups for this day.</p>
            </div>
          ) : (
            <ul className="agenda-list">
              {appointmentsOnDay(appointments, anchor).map((a) => (
                <li key={a.id}>
                  <Link
                    to={`/app/sessions/${a.presentationId}`}
                    className={toneClass(a.statusTone)}
                  >
                    <strong>{a.followUpTime}</strong> · {a.clientName}
                    <span className="muted small"> · {a.statusTone}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
