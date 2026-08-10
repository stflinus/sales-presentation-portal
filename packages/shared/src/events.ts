/** Append-only audit event types. */
export const AUDIT_EVENT = {
  INVITATION_CREATED: "invitation_created",
  INVITATION_SENT: "invitation_sent",
  INVITATION_OPENED: "invitation_opened",
  NOTIFICATION_QUEUED: "notification_queued",
  NOTIFICATION_SENT: "notification_sent",
  NOTIFICATION_FAILED: "notification_failed",
  CONTACT_CREATED: "contact_created",
  CONTACT_UPDATED: "contact_updated",
  CONTACT_ARCHIVED: "contact_archived",
  CONTACT_RESTORED: "contact_restored",
  CONTACT_DELETED: "contact_deleted",
  CONTACT_REASSIGNED: "contact_reassigned",
  LEGAL_EVIDENCE_CREATED: "legal_evidence_created",
  LEGAL_EVIDENCE_EXPORTED: "legal_evidence_exported",
  PRESENTATION_DELETED: "presentation_deleted",
  LEGAL_DISPLAYED: "legal_displayed",
  LEGAL_ACCEPTED: "legal_accepted",
  LEGAL_DOCUMENT_VIEWED: "legal_document_viewed",
  VIDEO_UPLOADED: "video_uploaded",
  VIDEO_ACTIVATED: "video_activated",
  VIDEO_DEACTIVATED: "video_deactivated",
  VIDEO_ARCHIVED: "video_archived",
  VIDEO_DELETED: "video_deleted",
  VIDEO_STARTED: "video_started",
  PLAYBACK_PROGRESS: "playback_progress",
  VIDEO_COMPLETED: "video_completed",
  SESSION_CLOSED: "session_closed",
  FAILED_ACCESS_ATTEMPT: "failed_access_attempt",
  REPRESENTATIVE_ACTION: "representative_action",
  ADMINISTRATOR_ACTION: "administrator_action",
  FOLLOWUP_SCHEDULED: "followup_scheduled",
  FOLLOWUP_COMPLETED: "followup_completed",
  EMAIL_SENT: "email_sent",
  EMAIL_FAILED: "email_failed",
} as const;

export type AuditEventType =
  (typeof AUDIT_EVENT)[keyof typeof AUDIT_EVENT];

/** Analytics metric keys stored on session.analytics and analyticsEvents. */
export const ANALYTICS_METRIC = {
  INVITATION_SENT_AT: "invitationSentAt",
  INVITATION_OPENED_AT: "invitationOpenedAt",
  TIME_UNTIL_NDA_MS: "timeUntilNdaMs",
  TIME_UNTIL_VIDEO_START_MS: "timeUntilVideoStartMs",
  WATCH_DURATION_MS: "watchDurationMs",
  COMPLETION_PERCENT: "completionPercent",
  COMPLETION_TIME: "completionTime",
  FOLLOWUP_SCHEDULED_AT: "followupScheduledAt",
  FOLLOWUP_COMPLETED_AT: "followupCompletedAt",
} as const;
