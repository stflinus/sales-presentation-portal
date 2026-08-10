import {
  SESSION_STATUS,
  type PresentationSession,
} from "@spp/shared";

/** Visual status keys used by badges and summary cards. */
export type StatusTone =
  | "pending"
  | "opened"
  | "legal_accepted"
  | "started"
  | "completed"
  | "won"
  | "lost"
  | "deleted"
  | "neutral";

export interface StatusDescriptor {
  tone: StatusTone;
  label: string;
}

const SESSION_STATUS_MAP: Record<string, StatusDescriptor> = {
  [SESSION_STATUS.PENDING]: { tone: "pending", label: "Pending Invitation" },
  [SESSION_STATUS.OPENED]: { tone: "opened", label: "Invitation Opened" },
  [SESSION_STATUS.LEGAL_ACCEPTED]: {
    tone: "legal_accepted",
    label: "Legal Accepted",
  },
  [SESSION_STATUS.IN_PROGRESS]: {
    tone: "started",
    label: "Presentation Started",
  },
  [SESSION_STATUS.COMPLETED]: {
    tone: "completed",
    label: "Presentation Completed",
  },
  [SESSION_STATUS.CLOSED]: {
    tone: "completed",
    label: "Presentation Completed",
  },
  [SESSION_STATUS.EXPIRED]: { tone: "neutral", label: "Expired" },
  [SESSION_STATUS.REVOKED]: { tone: "deleted", label: "Revoked" },
};

export function presentationStatusDescriptor(
  session: Pick<PresentationSession, "status" | "salesOutcome">,
): StatusDescriptor {
  if (session.salesOutcome === "won") {
    return { tone: "won", label: "Won" };
  }
  if (session.salesOutcome === "lost") {
    return { tone: "lost", label: "Lost" };
  }
  return (
    SESSION_STATUS_MAP[session.status] || {
      tone: "neutral",
      label: String(session.status).replaceAll("_", " "),
    }
  );
}

export function StatusBadge({
  tone,
  label,
  className = "",
}: {
  tone: StatusTone;
  label: string;
  className?: string;
}) {
  return (
    <span className={`status-badge status-${tone} ${className}`.trim()}>
      {label}
    </span>
  );
}

/** Presentation lifecycle status only — follow-up is scheduling metadata, not status. */
export function PresentationStatusBadges({
  session,
}: {
  session: Pick<PresentationSession, "status" | "salesOutcome">;
}) {
  const primary = presentationStatusDescriptor(session);
  return (
    <span className="status-badge-row">
      <StatusBadge tone={primary.tone} label={primary.label} />
    </span>
  );
}
