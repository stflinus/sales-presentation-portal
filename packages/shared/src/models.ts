import type {
  ContactStatus,
  FollowUpReminderStatus,
  FollowUpStatus,
  InviteStatus,
  LegalDocType,
  SessionStatus,
  VideoStatus,
} from "./session";
import type { Permission, RoleId } from "./permissions";
import type { NotificationProviderId } from "./notifications";
import type { VideoProcessingState, SlideMarker } from "./videoProcessing";

export type UtcIso = string;

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  /** Optional staff title for invitation email signatures. */
  title?: string | null;
  /** Optional staff phone for invitation email signatures. */
  phone?: string | null;
  roleIds: RoleId[];
  primaryRole: RoleId;
  permissions: Permission[];
  /** null for platform administrators */
  companyId: string | null;
  status: "active" | "inactive" | "disabled";
  /** Staff UI preferences (e.g. dashboard.followUpView). */
  preferences?: {
    dashboard?: {
      followUpView?: "list" | "calendar";
    };
  };
  /** Administrator-assigned presentation defaults for new invitations. */
  presentationSettings?: import("./accessPolicy").UserPresentationSettings | null;
  createdAt: UtcIso;
  createdBy: string | null;
  updatedAt: UtcIso;
}

export interface RoleDoc {
  id: RoleId;
  name: string;
  permissions: Permission[];
}

export interface PortalSettings {
  activeNdaId: string;
  activeTermsId: string;
  activePrivacyId: string;
  activeVideoId: string;
  defaultInviteTtlHours: number;
  companyName: string;
  supportEmail: string;
  appVersion: string;
  defaultCompanyId?: string;
  /** Platform notification defaults — provider selectable without invite code changes. */
  notifications?: NotificationPlatformSettings;
  /** Firebase Trigger Email extension readiness (no SMTP). */
  firebaseEmail?: {
    configured?: boolean;
    configuredAt?: string | null;
    configuredBy?: string | null;
    lastTestAt?: string | null;
    lastTestMailId?: string | null;
  } | null;
}

export interface NotificationPlatformSettings {
  defaultProvider: NotificationProviderId;
  defaultSenderDisplayName: string;
  defaultInvitationSubject: string;
  defaultFooter: string;
  /** Platform SMTP envelope From address (optional; provider may supply). */
  defaultFromEmail?: string | null;
}

export type CompanyStatus = "active" | "inactive";

export interface CompanyBranding {
  primaryColor?: string | null;
  logoUrl?: string | null;
  displayName?: string | null;
}

/** Company email branding — customization UI deferred; architecture reserved. */
export interface CompanyEmailBranding {
  logoUrl?: string | null;
  primaryColor?: string | null;
  invitationSubject?: string | null;
  invitationTemplateId?: string | null;
  /** @deprecated Prefer Company.displayEmailName */
  senderDisplayName?: string | null;
  senderEmail?: string | null;
  footerText?: string | null;
}

export interface Company {
  id: string;
  name: string;
  status: CompanyStatus;
  createdAt: UtcIso;
  createdBy: string;
  updatedAt: UtcIso;
  branding: CompanyBranding;
  emailBranding?: CompanyEmailBranding;
  /**
   * Outbound From display name shown to recipients.
   * Example: "Serenity 1" → From: Serenity 1 <smtp@…>
   * Never hardcode; falls back to company.name when empty.
   */
  displayEmailName?: string | null;
  /** Gmail address used for SMTP auth and From envelope (not the App Password). */
  smtpGmailAddress?: string | null;
  /** Optional Reply-To for invitation email; falls back to Gmail address. */
  replyToEmail?: string | null;
  /** True when an App Password has been saved (secret never exposed to clients). */
  emailConfigured?: boolean;
  /** Connection / last-test status for admin UI. */
  emailConnectionStatus?:
    | "not_configured"
    | "configured"
    | "connected"
    | "authentication_failed"
    | "connection_failed"
    /** @deprecated use connected */
    | "verified"
    /** @deprecated use authentication_failed | connection_failed */
    | "error"
    | null;
  emailLastTestAt?: UtcIso | null;
  emailLastError?: string | null;
  activeNdaId: string;
  activeTermsId: string;
  activePrivacyId: string;
  activeVideoId: string;
  managerIds: string[];
  representativeIds: string[];
  defaultInviteTtlHours: number;
}

export interface LegalDocument {
  id: string;
  type: LegalDocType;
  versionLabel: string;
  title: string;
  body: string;
  contentSha256: string;
  status: "draft" | "placeholder" | "active" | "archived";
  isPlaceholder: boolean;
  companyId: string;
  createdAt: UtcIso;
  createdBy: string;
  activatedAt?: UtcIso;
  /** YYYY-MM-DD when the version becomes effective */
  effectiveDate?: string;
  /** True when this version is the live document for its type */
  active?: boolean;
  /** Prior legalDocuments id replaced by this version (never overwritten) */
  previousVersionId?: string | null;
  /** Public Hosting path or Storage path to immutable original PDF */
  originalPdfPath?: string;
}

export interface VideoAsset {
  id: string;
  title: string;
  description: string;
  companyId: string;
  versionNumber: string;
  uploadDate: UtcIso;
  uploadedBy: string;
  storagePath: string;
  /** Optimized video path (transcoded for streaming). */
  optimizedStoragePath?: string | null;
  /** Final playback path (optimized or original if compatible). */
  playbackStoragePath?: string | null;
  fileSize: number | null;
  durationSeconds: number | null;
  thumbnailPath: string | null;
  status: VideoStatus;
  active: boolean;
  archived: boolean;
  deleted: boolean;
  allowExistingSessions: boolean;
  replacementReason?: string | null;
  contentType: string;
  sizeBytes: number | null;
  checksumSha256?: string;
  campaignIds: string[];
  isPlaceholder: boolean;
  createdAt: UtcIso;
  createdBy: string;
  activatedAt?: UtcIso | null;
  deactivatedAt?: UtcIso | null;
  archivedAt?: UtcIso | null;
  deletedAt?: UtcIso | null;
  /** Video processing pipeline state. */
  processing?: VideoProcessingState | null;
  /** Slide markers for chapter navigation. */
  slideMarkers?: SlideMarker[] | null;
  /** Scheduled permanent deletion timestamp (archived videos only). */
  scheduledPermanentDeletionAt?: UtcIso | null;
  /** Timestamp when video was restored from archive. */
  restoredAt?: UtcIso | null;
  /** Timestamp when video was permanently deleted. */
  permanentlyDeletedAt?: UtcIso | null;
  /** Deletion postponed until this timestamp (due to active sessions). */
  deletionPostponedUntil?: UtcIso | null;
  /** Reason deletion was postponed. */
  deletionPostponedReason?: string | null;
  /** True when doc is a lightweight historical record after permanent delete. */
  tombstone?: boolean;
  /** UID of user who initiated permanent deletion. */
  deletedBy?: string | null;
}

export interface VideoVersionHistoryEntry {
  id: string;
  videoId: string;
  versionNumber: string;
  uploadDate: UtcIso;
  uploadedBy: string;
  companyId: string;
  status: VideoStatus;
  replacementReason?: string | null;
  createdAt: UtcIso;
}


export interface ViewingLease {
  sessionId: string;
  deviceId: string;
  status: "active" | "released" | "consumed";
  acquiredAt: UtcIso;
  leaseExpiresAt: UtcIso;
  lastHeartbeatAt: UtcIso;
  meaningfulPlaybackStarted: boolean;
}

export interface InviteRecord {
  id: string;
  tokenHash: string;
  createdBy: string;
  representativeName: string;
  clientName: string;
  clientEmail: string;
  status: InviteStatus;
  expiresAt: UtcIso;
  sessionId: string;
  videoId: string;
  companyId: string;
  contactId?: string | null;
  createdAt: UtcIso;
  sentAt?: UtcIso;
  openedAt?: UtcIso;
  /** Latest notification id for this invitation (email delivery). */
  lastNotificationId?: string | null;
  notificationStatus?: string | null;
  notificationFailureReason?: string | null;
  /** Snapshotted access policy — authoritative after creation. */
  accessPolicy?: import("./accessPolicy").AccessPolicy;
  accessDurationDays?: number | null;
  policyAppliedAt?: UtcIso | null;
  viewingEntitlementConsumed?: boolean;
}

export interface SessionAnalytics {
  invitationSentAt?: UtcIso;
  invitationOpenedAt?: UtcIso;
  timeUntilNdaMs?: number;
  timeUntilVideoStartMs?: number;
  watchDurationMs?: number;
  completionPercent?: number;
  completionTime?: UtcIso;
  followupScheduledAt?: UtcIso;
  followupCompletedAt?: UtcIso;
  videoVersionId?: string;
  representativeId?: string;
}

export interface PresentationSession {
  id: string;
  inviteId: string;
  representativeId: string;
  representativeName: string;
  clientName: string;
  clientEmail: string;
  status: SessionStatus;
  videoId: string;
  companyId: string;
  /** Company display name for client welcome screens. */
  companyName?: string | null;
  contactId?: string | null;
  legalAcceptanceId?: string;
  /** Per-document acceptance record ids (NDA, Terms, Privacy). */
  legalAcceptanceIds?: string[];
  ndaVersionId?: string;
  termsVersionId?: string;
  privacyVersionId?: string;
  viewingDeviceId?: string;
  maxWatchedSeconds: number;
  completionPercent: number;
  completedAt?: UtcIso;
  closedAt?: UtcIso;
  expiresAt: UtcIso;
  representativeNotes: string;
  /**
   * Follow-up is an attribute of this Presentation — never a separate
   * operational sales record. One Presentation ID for calendar/reminders.
   */
  followUpStatus: FollowUpStatus;
  /** Canonical UTC instant for sorting / due checks. */
  followUpAt?: UtcIso | null;
  /** Calendar date (YYYY-MM-DD) in the scheduler's local intent. */
  followUpDate?: string | null;
  /** Local time (HH:mm) paired with followUpDate. */
  followUpTime?: string | null;
  /** Future Google Calendar event id — references this Presentation. */
  followUpCalendarEventId?: string | null;
  /** Reminder pipeline status for this Presentation's follow-up. */
  followUpReminderStatus?: FollowUpReminderStatus | null;
  /** Optional notes for the follow-up (stored on the Presentation). */
  followUpNotes?: string | null;
  /**
   * @deprecated Legacy pointer to followUps collection. No longer written;
   * follow-up data lives on this Presentation document.
   */
  followUpId?: string | null;
  /** Optional sales outcome — only counted when explicitly set (never invented). */
  salesOutcome?: "won" | "lost" | null;
  /**
   * Secure invitation URL (`/i/{token}`) for representative copy/share.
   * Same URL used by the invitation system — never expose tokenHash.
   */
  inviteUrl?: string | null;
  /** Aggregated Presentation Health for dashboard (admin support). */
  healthStatus?: "healthy" | "warning" | "error" | null;
  healthSummary?: string | null;
  healthUpdatedAt?: UtcIso | null;
  /**
   * Last validated client interaction (open, authorize, legal, playback, etc.).
   * Used for operational inactivity cleanup — never updated by staff/admin reads.
   * Seeded to createdAt when the invitation is created.
   */
  lastMeaningfulClientActivityAt?: UtcIso | null;
  /** Snapshotted access policy — authoritative after creation. */
  accessPolicy?: import("./accessPolicy").AccessPolicy;
  accessDurationDays?: number | null;
  policyAppliedAt?: UtcIso | null;
  /** True after a successful single-view entitlement is consumed. */
  viewingEntitlementConsumed?: boolean;
  analytics: SessionAnalytics;
  createdAt: UtcIso;
  updatedAt: UtcIso;
  /** Viewer device/session binding (invitation-link claim; OTP fields deprecated). */
  viewerAuth?: ViewerAuthState | null;
}

/** Viewer device binding state (HttpOnly cookie ↔ authorizedSessionId). */
export interface ViewerAuthState {
  /** Legacy name: set when the authorized browser is bound (not email OTP). */
  emailVerifiedAt?: UtcIso | null;
  authorizedSessionId?: string | null;
  authorizedAt?: UtcIso | null;
  /** @deprecated OTP removed from client flow. */
  otpHash?: string | null;
  /** @deprecated */
  otpExpiresAt?: UtcIso | null;
  /** @deprecated */
  otpAttempts?: number;
  /** @deprecated */
  otpSentAt?: UtcIso | null;
  deviceResetCount?: number;
  lastDeviceResetAt?: UtcIso | null;
  lastDeviceResetBy?: string | null;
}

export interface LegalDocumentSnapshot {
  type: LegalDocType;
  documentId: string;
  versionLabel: string;
  title: string;
  body: string;
  contentSha256: string;
  effectiveDate?: string | null;
}

/**
 * Immutable per-document legal acceptance (one record each for NDA, Terms, Privacy).
 */
export interface LegalAcceptance {
  id: string;
  documentType: LegalDocType;
  documentVersion: string;
  effectiveDate: string | null;
  contentSha256: string;
  documentId: string;
  acceptanceTimestamp: UtcIso;
  invitationId: string;
  /** Null when the sales Presentation/session was permanently deleted. */
  presentationSessionId: string | null;
  representativeId: string;
  companyId: string;
  /** Null when Contact was deleted — legal evidence remains searchable. */
  contactId: string | null;
  clientName: string;
  clientEmail: string;
  ipAddress: string;
  browser: string;
  operatingSystem: string;
  deviceType: string;
  screenResolution: string;
  userAgent: string;
  /** Groups the three acceptances from one Continue click. */
  acceptanceBatchId: string;
  representativeName: string;
  ndaVersionId: string;
  termsVersionId: string;
  privacyVersionId: string;
  agreementChecked: true;
  acceptedAtUtc: UtcIso;
  videoAssignedId: string;
  applicationVersion: string;
  auditSignature: string;
  immutable: true;
}

export interface LegalDocumentViewEvent {
  id: string;
  documentType: LegalDocType;
  documentId: string;
  documentVersion: string;
  presentationSessionId: string;
  invitationId: string;
  openedAtUtc: UtcIso;
  closedAtUtc?: UtcIso | null;
  informationalOnly: true;
}

/**
 * @deprecated Follow-ups are Presentation attributes. Kept for type compatibility
 * with historical Firestore docs only — do not create new operational records.
 */
export interface FollowUp {
  id: string;
  sessionId: string;
  representativeId: string;
  companyId: string;
  contactId?: string | null;
  clientName: string;
  clientEmail: string;
  scheduledAt: UtcIso;
  status: FollowUpStatus;
  notes: string;
  calendarEventId?: string | null;
  createdAt: UtcIso;
  updatedAt: UtcIso;
}

/** Prospective or existing customer owned by a Representative. */
export interface Contact {
  id: string;
  displayName: string;
  email: string;
  phone?: string | null;
  companyId: string;
  ownerRepresentativeId: string | null;
  status: ContactStatus;
  notes?: string;
  createdAt: UtcIso;
  createdBy: string;
  updatedAt: UtcIso;
  updatedBy?: string | null;
  archivedAt?: UtcIso | null;
  archivedBy?: string | null;
  deletedAt?: UtcIso | null;
  deletedBy?: string | null;
  lastInvitedAt?: UtcIso | null;
  lastSessionId?: string | null;
  lastInviteId?: string | null;
}

/** Permanent contact snapshot captured at legal acceptance — never overwritten. */
export interface LegalEvidenceContactSnapshot {
  contactId: string | null;
  displayName: string;
  email: string;
  capturedAt: UtcIso;
}

/**
 * Append-only Legal Evidence Vault record (one per acceptance batch).
 * Never updated except ContactID / sessionId may be set null when those
 * operational records are permanently deleted.
 */
export interface LegalEvidenceRecord {
  id: string;
  companyId: string;
  representativeId: string;
  representativeName: string;
  invitationId: string;
  /** Null when the sales Presentation/session was permanently deleted. */
  sessionId: string | null;
  /** Null when Contact was deleted — snapshot remains. */
  contactId: string | null;
  /**
   * Invitation fields retained for evidence after the sales invite record
   * is permanently deleted. Never contains token material.
   */
  invitationSnapshot?: {
    invitationId: string;
    clientName: string;
    clientEmail: string;
    representativeName: string;
    companyId: string;
    videoId: string;
    createdAt: string | null;
    sentAt: string | null;
    openedAt: string | null;
    expiresAt: string | null;
  } | null;
  contactSnapshot: LegalEvidenceContactSnapshot;
  contactName: string;
  contactEmail: string;
  acceptedNda: true;
  acceptedTerms: true;
  acceptedPrivacy: true;
  ndaDocumentId: string;
  termsDocumentId: string;
  privacyDocumentId: string;
  ndaVersion: string;
  termsVersion: string;
  privacyVersion: string;
  ndaEffectiveDate: string | null;
  termsEffectiveDate: string | null;
  privacyEffectiveDate: string | null;
  acceptanceTimestamp: UtcIso;
  ndaContentSha256: string;
  termsContentSha256: string;
  privacyContentSha256: string;
  legalAcceptanceIds: string[];
  acceptanceBatchId: string;
  auditSignature: string;
  auditEventIds: string[];
  ipAddress: string;
  browser: string;
  operatingSystem: string;
  deviceType: string;
  userAgent: string;
  screenResolution: string;
  videoVersionId: string;
  applicationVersion: string;
  immutable: true;
  createdAt: UtcIso;
}
