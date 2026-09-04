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
  PRESENTATION_POLICY_APPLIED: "presentation_policy_applied",
  PRESENTATION_REOPENED: "presentation_reopened",
  VIEWING_ENTITLEMENT_CONSUMED: "viewing_entitlement_consumed",
  ACCESS_DENIED: "access_denied",
  // Player lifecycle events
  PLAYER_INITIALIZED: "player_initialized",
  MEDIA_LOAD_STARTED: "media_load_started",
  METADATA_LOADED: "metadata_loaded",
  CAN_PLAY: "can_play",
  PLAYBACK_STARTED: "playback_started",
  PLAYBACK_PAUSED: "playback_paused",
  BUFFERING_STARTED: "buffering_started",
  BUFFERING_ENDED: "buffering_ended",
  SEEK_STARTED: "seek_started",
  SEEK_COMPLETED: "seek_completed",
  SLIDE_CHANGED: "slide_changed",
  PLAYBACK_RATE_CHANGED: "playback_rate_changed",
  PLAYBACK_COMPLETED: "playback_completed",
  MEDIA_ERROR: "media_error",
  AUTHORIZATION_ERROR: "authorization_error",
  /** @deprecated Email OTP removed — invitation link + device cookie binding replaces it. */
  OTP_SENT: "otp_sent",
  /** @deprecated */
  OTP_VERIFIED: "otp_verified",
  /** @deprecated */
  OTP_FAILED: "otp_failed",
  DEVICE_AUTHORIZED: "device_authorized",
  NEW_DEVICE_BLOCKED: "new_device_blocked",
  /** Signed playback URL minted after server authorization checks. */
  PLAYBACK_AUTHORIZED: "playback_authorized",
  SESSION_EXPIRED: "session_expired",
  VIDEO_PROCESSING_FAILED: "video_processing_failed",
  DEVICE_RESET: "device_reset",
  // Video processing lifecycle events
  PROCESSING_REQUESTED: "processing_requested",
  ANALYSIS_STARTED: "analysis_started",
  OPTIMIZATION_STARTED: "optimization_started",
  SLIDE_DETECTION_STARTED: "slide_detection_started",
  VERIFICATION_STARTED: "verification_started",
  PROCESSING_COMPLETED: "processing_completed",
  PLAYBACK_ASSET_ACTIVATED: "playback_asset_activated",
  PROCESSING_FAILED: "processing_failed",
  // Video archive/deletion lifecycle events
  VIDEO_ARCHIVED: "video_archived",
  VIDEO_RESTORED: "video_restored",
  VIDEO_DELETION_SCHEDULED: "video_deletion_scheduled",
  VIDEO_DELETION_POSTPONED_ACTIVE_SESSION: "video_deletion_postponed_active_session",
  VIDEO_PERMANENTLY_DELETED: "video_permanently_deleted",
  VIDEO_DELETION_FAILED: "video_deletion_failed",
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
  [ACTIVITY_EVENT.PRESENTATION_POLICY_APPLIED]: "Presentation Policy Applied",
  [ACTIVITY_EVENT.PRESENTATION_REOPENED]: "Presentation Reopened",
  [ACTIVITY_EVENT.VIEWING_ENTITLEMENT_CONSUMED]: "Viewing Entitlement Consumed",
  [ACTIVITY_EVENT.ACCESS_DENIED]: "Access Denied",
  // Player lifecycle labels
  [ACTIVITY_EVENT.PLAYER_INITIALIZED]: "Player Initialized",
  [ACTIVITY_EVENT.MEDIA_LOAD_STARTED]: "Media Load Started",
  [ACTIVITY_EVENT.METADATA_LOADED]: "Metadata Loaded",
  [ACTIVITY_EVENT.CAN_PLAY]: "Ready to Play",
  [ACTIVITY_EVENT.PLAYBACK_STARTED]: "Playback Started",
  [ACTIVITY_EVENT.PLAYBACK_PAUSED]: "Playback Paused",
  [ACTIVITY_EVENT.BUFFERING_STARTED]: "Buffering Started",
  [ACTIVITY_EVENT.BUFFERING_ENDED]: "Buffering Ended",
  [ACTIVITY_EVENT.SEEK_STARTED]: "Seek Started",
  [ACTIVITY_EVENT.SEEK_COMPLETED]: "Seek Completed",
  [ACTIVITY_EVENT.SLIDE_CHANGED]: "Slide Changed",
  [ACTIVITY_EVENT.PLAYBACK_RATE_CHANGED]: "Playback Rate Changed",
  [ACTIVITY_EVENT.PLAYBACK_COMPLETED]: "Playback Completed",
  [ACTIVITY_EVENT.MEDIA_ERROR]: "Media Error",
  [ACTIVITY_EVENT.AUTHORIZATION_ERROR]: "Authorization Error",
  // OTP and device binding labels
  [ACTIVITY_EVENT.OTP_SENT]: "Verification Code Sent (deprecated)",
  [ACTIVITY_EVENT.OTP_VERIFIED]: "Email Verified (deprecated)",
  [ACTIVITY_EVENT.OTP_FAILED]: "Verification Failed (deprecated)",
  [ACTIVITY_EVENT.DEVICE_AUTHORIZED]: "Device Authorized",
  [ACTIVITY_EVENT.NEW_DEVICE_BLOCKED]: "New Device Blocked",
  [ACTIVITY_EVENT.PLAYBACK_AUTHORIZED]: "Playback Authorized",
  [ACTIVITY_EVENT.SESSION_EXPIRED]: "Session Expired",
  [ACTIVITY_EVENT.VIDEO_PROCESSING_FAILED]: "Video Processing Failed",
  [ACTIVITY_EVENT.DEVICE_RESET]: "Authorized Device Reset",
  // Video processing lifecycle labels
  [ACTIVITY_EVENT.PROCESSING_REQUESTED]: "Processing Requested",
  [ACTIVITY_EVENT.ANALYSIS_STARTED]: "Analysis Started",
  [ACTIVITY_EVENT.OPTIMIZATION_STARTED]: "Optimization Started",
  [ACTIVITY_EVENT.SLIDE_DETECTION_STARTED]: "Slide Detection Started",
  [ACTIVITY_EVENT.VERIFICATION_STARTED]: "Verification Started",
  [ACTIVITY_EVENT.PROCESSING_COMPLETED]: "Processing Completed",
  [ACTIVITY_EVENT.PLAYBACK_ASSET_ACTIVATED]: "Playback Asset Activated",
  [ACTIVITY_EVENT.PROCESSING_FAILED]: "Processing Failed",
  // Video archive/deletion lifecycle labels
  [ACTIVITY_EVENT.VIDEO_ARCHIVED]: "Video Archived",
  [ACTIVITY_EVENT.VIDEO_RESTORED]: "Video Restored",
  [ACTIVITY_EVENT.VIDEO_DELETION_SCHEDULED]: "Deletion Scheduled",
  [ACTIVITY_EVENT.VIDEO_DELETION_POSTPONED_ACTIVE_SESSION]: "Deletion Postponed (Active Session)",
  [ACTIVITY_EVENT.VIDEO_PERMANENTLY_DELETED]: "Video Permanently Deleted",
  [ACTIVITY_EVENT.VIDEO_DELETION_FAILED]: "Video Deletion Failed",
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
