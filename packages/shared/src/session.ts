/** Presentation session lifecycle. Terminal states never reopen. */
export const SESSION_STATUS = {
  PENDING: "pending",
  OPENED: "opened",
  LEGAL_ACCEPTED: "legal_accepted",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  CLOSED: "closed",
  EXPIRED: "expired",
  REVOKED: "revoked",
} as const;

export type SessionStatus =
  (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS];

/** Permanently consumed — never reopen; create a new invitation instead. */
export const CONSUMED_SESSION_STATUSES: readonly SessionStatus[] = [
  SESSION_STATUS.COMPLETED,
  SESSION_STATUS.CLOSED,
];

export const TERMINAL_SESSION_STATUSES: readonly SessionStatus[] = [
  SESSION_STATUS.COMPLETED,
  SESSION_STATUS.CLOSED,
  SESSION_STATUS.EXPIRED,
  SESSION_STATUS.REVOKED,
];

export function isTerminalStatus(status: SessionStatus): boolean {
  return (TERMINAL_SESSION_STATUSES as readonly string[]).includes(status);
}

export function isConsumedStatus(status: SessionStatus): boolean {
  return (CONSUMED_SESSION_STATUSES as readonly string[]).includes(status);
}

export const INVITE_STATUS = {
  PENDING: "pending",
  SENT: "sent",
  OPENED: "opened",
  ACCEPTED: "accepted",
  COMPLETED: "completed",
  EXPIRED: "expired",
  REVOKED: "revoked",
} as const;

export type InviteStatus = (typeof INVITE_STATUS)[keyof typeof INVITE_STATUS];

export const LEGAL_DOC_TYPE = {
  NDA: "nda",
  TERMS: "terms",
  PRIVACY: "privacy",
} as const;

export type LegalDocType =
  (typeof LEGAL_DOC_TYPE)[keyof typeof LEGAL_DOC_TYPE];

export const CONTENT_STATUS = {
  DRAFT: "draft",
  PLACEHOLDER: "placeholder",
  ACTIVE: "active",
  ARCHIVED: "archived",
} as const;

export type ContentStatus =
  (typeof CONTENT_STATUS)[keyof typeof CONTENT_STATUS];

/** Presentation video lifecycle (separate from legal CONTENT_STATUS). */
export const VIDEO_STATUS = {
  DRAFT: "draft",
  ACTIVE: "active",
  INACTIVE: "inactive",
  ARCHIVED: "archived",
  DELETED: "deleted",
} as const;

export type VideoStatus = (typeof VIDEO_STATUS)[keyof typeof VIDEO_STATUS];

/** Maximum allowed MP4 upload size (2 GiB). Use everywhere — FE, Functions, Storage rules. */
export const MAX_VIDEO_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024;

/** Human-readable label for UI copy. */
export const MAX_VIDEO_UPLOAD_SIZE_LABEL = "2 GB";

export const FOLLOWUP_STATUS = {
  NONE: "none",
  SCHEDULED: "scheduled",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
} as const;

export type FollowUpStatus =
  (typeof FOLLOWUP_STATUS)[keyof typeof FOLLOWUP_STATUS];

/**
 * Reminder pipeline status for a Presentation follow-up attribute.
 * Distinct from Google Calendar sync (future).
 */
export const FOLLOWUP_REMINDER_STATUS = {
  NONE: "none",
  PENDING: "pending",
  SENT: "sent",
  CANCELLED: "cancelled",
} as const;

export type FollowUpReminderStatus =
  (typeof FOLLOWUP_REMINDER_STATUS)[keyof typeof FOLLOWUP_REMINDER_STATUS];

/** Contact lifecycle statuses (prospective / existing customer). */
export const CONTACT_STATUS = {
  LEAD: "lead",
  INVITED: "invited",
  PRESENTATION_STARTED: "presentation_started",
  PRESENTATION_COMPLETED: "presentation_completed",
  QUALIFIED: "qualified",
  CUSTOMER: "customer",
  ARCHIVED: "archived",
  DELETED: "deleted",
} as const;

export type ContactStatus =
  (typeof CONTACT_STATUS)[keyof typeof CONTACT_STATUS];

export const VIEWING_LEASE_STATUS = {
  ACTIVE: "active",
  RELEASED: "released",
  CONSUMED: "consumed",
} as const;

export type ViewingLeaseStatus =
  (typeof VIEWING_LEASE_STATUS)[keyof typeof VIEWING_LEASE_STATUS];

/**
 * Server-managed viewing lease TTL.
 * Heartbeats renew the lease. Expiry does NOT consume the one-time viewing.
 */
export const VIEWING_LEASE_TTL_MS = 90_000;

/** Signed URL lifetime. Renewal requires an eligible session + lease rules. */
export const SIGNED_URL_TTL_MS = 5 * 60 * 1000;

/** Playback progress (seconds) that counts as meaningful playback / lease start. */
export const MEANINGFUL_PLAYBACK_SECONDS = 1;

/** Percent of duration that counts as completed (heartbeat-based). */
export const VIDEO_COMPLETION_THRESHOLD = 0.9;

export const APP_VERSION = "0.1.0";
