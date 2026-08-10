/** Presentation Health / Activity — admin diagnostic timeline. */

export const ACTIVITY_SEVERITY = {
  SUCCESS: "success",
  WARNING: "warning",
  ERROR: "error",
  INFO: "info",
} as const;

export type ActivitySeverity =
  (typeof ACTIVITY_SEVERITY)[keyof typeof ACTIVITY_SEVERITY];

export const PRESENTATION_HEALTH = {
  HEALTHY: "healthy",
  WARNING: "warning",
  ERROR: "error",
} as const;

export type PresentationHealthStatus =
  (typeof PRESENTATION_HEALTH)[keyof typeof PRESENTATION_HEALTH];

export const ACTIVITY_EVENT = {
  INVITATION_CREATED: "invitation_created",
  INVITATION_OPENED: "invitation_opened",
  INVITATION_EXPIRED: "invitation_expired",
  INVITATION_REVOKED: "invitation_revoked",
  SECOND_VIEWING_ATTEMPT: "second_viewing_attempt",
  DEVICE_CAPTURED: "device_captured",
  LEGAL_LOADED: "legal_loaded",
  NDA_ACCEPTED: "nda_accepted",
  TERMS_ACCEPTED: "terms_accepted",
  PRIVACY_ACCEPTED: "privacy_accepted",
  LEGAL_ACCEPTED: "legal_accepted",
  PRESENTATION_READY: "presentation_ready",
  START_PRESENTATION_CLICKED: "start_presentation_clicked",
  VIDEO_BUFFERING: "video_buffering",
  VIDEO_STARTED: "video_started",
  PLAYBACK_ERROR: "playback_error",
  PROGRESS_UPDATE: "progress_update",
  PRESENTATION_COMPLETED: "presentation_completed",
  COMPLETION_RECORDED: "completion_recorded",
  BROWSER_CLOSED: "browser_closed",
  NETWORK_FAILURE: "network_failure",
  NETWORK_RETRY: "network_retry",
  TIMEOUT: "timeout",
  FAILED_ACCESS: "failed_access",
  UNEXPECTED_EXCEPTION: "unexpected_exception",
} as const;

export type ActivityEventType =
  (typeof ACTIVITY_EVENT)[keyof typeof ACTIVITY_EVENT];

/** Admin-only diagnostic payload — never sent to clients or representatives. */
export interface ActivityDiagnostics {
  errorSummary?: string | null;
  errorCode?: string | null;
  exceptionType?: string | null;
  cloudFunction?: string | null;
  firestoreCollection?: string | null;
  documentId?: string | null;
  storageObject?: string | null;
  browser?: string | null;
  browserVersion?: string | null;
  deviceType?: string | null;
  operatingSystem?: string | null;
  screenResolution?: string | null;
  networkStatus?: string | null;
  correlationId?: string | null;
  stackTrace?: string | null;
  recommendedAction?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  appVersion?: string | null;
}

export interface PresentationActivityEvent {
  id: string;
  sessionId: string;
  inviteId?: string | null;
  companyId?: string | null;
  representativeId?: string | null;
  type: ActivityEventType | string;
  severity: ActivitySeverity;
  title: string;
  description: string;
  errorCode?: string | null;
  deviceType?: string | null;
  browser?: string | null;
  operatingSystem?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
  actorType: "system" | "representative" | "administrator" | "client";
  actorUid?: string | null;
  payload?: Record<string, unknown>;
  diagnostics?: ActivityDiagnostics | null;
  createdAt: string;
}

/** Human labels for timeline UI. */
export const ACTIVITY_EVENT_LABEL: Record<string, string> = {
  [ACTIVITY_EVENT.INVITATION_CREATED]: "Invitation Created",
  [ACTIVITY_EVENT.INVITATION_OPENED]: "Invitation Opened",
  [ACTIVITY_EVENT.INVITATION_EXPIRED]: "Invitation Expired",
  [ACTIVITY_EVENT.INVITATION_REVOKED]: "Invitation Revoked",
  [ACTIVITY_EVENT.SECOND_VIEWING_ATTEMPT]: "Second Viewing Attempt",
  [ACTIVITY_EVENT.DEVICE_CAPTURED]: "Device",
  [ACTIVITY_EVENT.LEGAL_LOADED]: "Legal Documents Loaded",
  [ACTIVITY_EVENT.NDA_ACCEPTED]: "NDA Accepted",
  [ACTIVITY_EVENT.TERMS_ACCEPTED]: "Terms Accepted",
  [ACTIVITY_EVENT.PRIVACY_ACCEPTED]: "Privacy Accepted",
  [ACTIVITY_EVENT.LEGAL_ACCEPTED]: "Legal Accepted",
  [ACTIVITY_EVENT.PRESENTATION_READY]: "Presentation Ready",
  [ACTIVITY_EVENT.START_PRESENTATION_CLICKED]: "Start Presentation Clicked",
  [ACTIVITY_EVENT.VIDEO_BUFFERING]: "Video Buffering",
  [ACTIVITY_EVENT.VIDEO_STARTED]: "Video Started",
  [ACTIVITY_EVENT.PLAYBACK_ERROR]: "Playback Error",
  [ACTIVITY_EVENT.PROGRESS_UPDATE]: "Progress Update",
  [ACTIVITY_EVENT.PRESENTATION_COMPLETED]: "Video Completed",
  [ACTIVITY_EVENT.COMPLETION_RECORDED]: "Completion Recorded",
  [ACTIVITY_EVENT.BROWSER_CLOSED]: "Browser Closed",
  [ACTIVITY_EVENT.NETWORK_FAILURE]: "Network Failure",
  [ACTIVITY_EVENT.NETWORK_RETRY]: "Network Retry",
  [ACTIVITY_EVENT.TIMEOUT]: "Timeout",
  [ACTIVITY_EVENT.FAILED_ACCESS]: "Failed Access",
  [ACTIVITY_EVENT.UNEXPECTED_EXCEPTION]: "Unexpected Exception",
};

/** Suggested resolutions for admin support (keyed by error code or event type). */
export const ACTIVITY_RECOMMENDED_ACTION: Record<string, string> = {
  MEDIA_ELEMENT_ERROR:
    "Verify the video is MP4 (H.264 video + AAC audio). Re-encode and re-upload if needed.",
  GRANT_VIDEO_ACCESS_FAILED:
    "Verify Storage permissions and that the video object exists. Check signed URL configuration.",
  LEASE_ACQUIRE_FAILED:
    "Check viewing lease state. If another device holds the lease, wait or reset the interrupted session.",
  NETWORK_OFFLINE:
    "Ask the client to reconnect to a stable network and retry the invitation link.",
  VIDEO_MISSING:
    "Confirm the presentation video is Active in Video Library and the Storage object path is valid.",
  VIDEO_FILE_NOT_FOUND:
    "Verify Storage permissions and that the uploaded object was finalized successfully.",
  LEGAL_PLACEHOLDER:
    "Publish final NDA, Terms, and Privacy documents before sending invitations.",
  INVITE_EXPIRED: "Generate a new invitation for the client.",
  INVITE_REVOKED: "Generate a new invitation if access should be restored.",
  SECOND_VIEWING:
    "This presentation was already completed. Generate a new invitation for a fresh viewing.",
  SIGNING_CONFIG:
    "Verify Cloud Functions service account has Service Account Token Creator (signBlob) permission.",
  FIRESTORE_RULES:
    "Check Firestore Security Rules for the affected collection and authenticated role.",
  STORAGE_PERMISSIONS: "Verify Storage permissions and object ACLs for the video path.",
  CALENDAR_DISCONNECT: "Reconnect Google Calendar in company settings (when enabled).",
  RETRY_UPLOAD: "Retry the video upload and finalize the draft before activating.",
  NETWORK_RETRY: "Client retried after a transient network issue — monitor for recurrence.",
  DEFAULT_ERROR:
    "Review the diagnostic details below. If unresolved, generate a new invitation after fixing the root cause.",
  DEFAULT_WARNING:
    "Review the timeline event and recommended action. Contact the client if playback did not complete.",
};

export function recommendedActionFor(
  errorCode?: string | null,
  eventType?: string | null,
): string {
  if (errorCode && ACTIVITY_RECOMMENDED_ACTION[errorCode]) {
    return ACTIVITY_RECOMMENDED_ACTION[errorCode];
  }
  if (eventType && ACTIVITY_RECOMMENDED_ACTION[eventType]) {
    return ACTIVITY_RECOMMENDED_ACTION[eventType];
  }
  if (eventType === ACTIVITY_EVENT.VIDEO_BUFFERING) {
    return "Transient buffering is normal. If playback fails, verify MP4/H.264/AAC encoding and client network quality.";
  }
  if (eventType === ACTIVITY_EVENT.INVITATION_EXPIRED) {
    return ACTIVITY_RECOMMENDED_ACTION.INVITE_EXPIRED;
  }
  if (eventType === ACTIVITY_EVENT.INVITATION_REVOKED) {
    return ACTIVITY_RECOMMENDED_ACTION.INVITE_REVOKED;
  }
  if (eventType === ACTIVITY_EVENT.SECOND_VIEWING_ATTEMPT) {
    return ACTIVITY_RECOMMENDED_ACTION.SECOND_VIEWING;
  }
  if (eventType === ACTIVITY_EVENT.NETWORK_FAILURE) {
    return ACTIVITY_RECOMMENDED_ACTION.NETWORK_OFFLINE;
  }
  if (eventType === ACTIVITY_EVENT.PLAYBACK_ERROR) {
    return ACTIVITY_RECOMMENDED_ACTION.MEDIA_ELEMENT_ERROR;
  }
  return ACTIVITY_RECOMMENDED_ACTION.DEFAULT_ERROR;
}

export function rollupPresentationHealth(
  severities: Array<ActivitySeverity | string>,
): PresentationHealthStatus {
  let hasWarning = false;
  for (const s of severities) {
    if (s === ACTIVITY_SEVERITY.ERROR) return PRESENTATION_HEALTH.ERROR;
    if (s === ACTIVITY_SEVERITY.WARNING) hasWarning = true;
  }
  return hasWarning ? PRESENTATION_HEALTH.WARNING : PRESENTATION_HEALTH.HEALTHY;
}
