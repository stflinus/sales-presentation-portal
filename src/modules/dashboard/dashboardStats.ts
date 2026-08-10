import {
  FOLLOWUP_STATUS,
  SESSION_STATUS,
  type PresentationSession,
} from "@spp/shared";

export type DashboardStatusFilter =
  | "all"
  | "pending"
  | "opened"
  | "legal_accepted"
  | "started"
  | "completed"
  | "won"
  | "lost";

export function invitationSentAt(s: PresentationSession): string | undefined {
  return s.analytics?.invitationSentAt || s.createdAt;
}

export function presentationProgress(s: PresentationSession): string {
  if (
    s.status === SESSION_STATUS.COMPLETED ||
    s.status === SESSION_STATUS.CLOSED
  ) {
    return "100%";
  }
  if (s.status === SESSION_STATUS.IN_PROGRESS) {
    return `${Math.round(s.completionPercent || 0)}%`;
  }
  if (s.status === SESSION_STATUS.LEGAL_ACCEPTED) return "Legal accepted";
  if (s.status === SESSION_STATUS.OPENED) return "Opened";
  if (s.status === SESSION_STATUS.PENDING) return "Pending";
  return String(s.status);
}

export function isFollowUpDue(s: PresentationSession, now = Date.now()): boolean {
  return (
    s.followUpStatus === FOLLOWUP_STATUS.SCHEDULED &&
    Boolean(s.followUpAt) &&
    new Date(s.followUpAt!).getTime() <= now
  );
}

export function isFollowUpDueToday(s: PresentationSession): boolean {
  return (
    s.followUpStatus === FOLLOWUP_STATUS.SCHEDULED &&
    followUpBucket(s.followUpAt) === "today"
  );
}

export function matchesStatusFilter(
  s: PresentationSession,
  filter: DashboardStatusFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "pending":
      return s.status === SESSION_STATUS.PENDING;
    case "opened":
      return s.status === SESSION_STATUS.OPENED;
    case "legal_accepted":
      return s.status === SESSION_STATUS.LEGAL_ACCEPTED;
    case "started":
      return s.status === SESSION_STATUS.IN_PROGRESS;
    case "completed":
      return (
        s.status === SESSION_STATUS.COMPLETED ||
        s.status === SESSION_STATUS.CLOSED
      );
    case "won":
      return s.salesOutcome === "won";
    case "lost":
      return s.salesOutcome === "lost";
    default:
      return true;
  }
}

export function computeDashboardStats(sessions: PresentationSession[]) {
  return {
    pending: sessions.filter((s) => s.status === SESSION_STATUS.PENDING).length,
    opened: sessions.filter((s) => s.status === SESSION_STATUS.OPENED).length,
    legalAccepted: sessions.filter(
      (s) => s.status === SESSION_STATUS.LEGAL_ACCEPTED,
    ).length,
    started: sessions.filter((s) => s.status === SESSION_STATUS.IN_PROGRESS)
      .length,
    completed: sessions.filter(
      (s) =>
        s.status === SESSION_STATUS.COMPLETED ||
        s.status === SESSION_STATUS.CLOSED,
    ).length,
    followUpsDueToday: sessions.filter((s) => isFollowUpDueToday(s)).length,
    followUpsDue: sessions.filter((s) => isFollowUpDueToday(s)).length,
    won: sessions.filter((s) => s.salesOutcome === "won").length,
    lost: sessions.filter((s) => s.salesOutcome === "lost").length,
  };
}

export function followUpBucket(
  iso: string | null | undefined,
): "overdue" | "today" | "tomorrow" | "future" | "none" {
  if (!iso) return "none";
  const t = new Date(iso).getTime();
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const endToday = new Date(startToday);
  endToday.setDate(endToday.getDate() + 1);
  const endTomorrow = new Date(endToday);
  endTomorrow.setDate(endTomorrow.getDate() + 1);
  if (t < startToday.getTime()) return "overdue";
  if (t < endToday.getTime()) return "today";
  if (t < endTomorrow.getTime()) return "tomorrow";
  return "future";
}

/** Deduplicate by Presentation id (defensive — one operational record). */
export function uniquePresentations(
  sessions: PresentationSession[],
): PresentationSession[] {
  const seen = new Set<string>();
  const out: PresentationSession[] = [];
  for (const s of sessions) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

export const FOLLOWUP_VIEW_KEY = "dashboard.followUpView";
export type FollowUpView = "agenda" | "calendar";

const memoryPref: { followUpView: FollowUpView } = { followUpView: "agenda" };

export function readFollowUpViewPref(): FollowUpView {
  try {
    if (typeof localStorage !== "undefined") {
      const v = localStorage.getItem(FOLLOWUP_VIEW_KEY);
      if (v === "calendar") return "calendar";
      if (v === "agenda" || v === "list") return "agenda";
    }
  } catch {
    // ignore
  }
  return memoryPref.followUpView;
}

export function writeFollowUpViewPref(view: FollowUpView): void {
  memoryPref.followUpView = view;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(FOLLOWUP_VIEW_KEY, view);
    }
  } catch {
    // ignore
  }
}
