/** Notification delivery channels — invitation logic stays channel-agnostic. */
export const NOTIFICATION_CHANNEL = {
  EMAIL: "email",
  SMS: "sms",
  PUSH: "push",
} as const;

export type NotificationChannel =
  (typeof NOTIFICATION_CHANNEL)[keyof typeof NOTIFICATION_CHANNEL];

/**
 * Provider IDs selectable via platform settings without changing invitation logic.
 * Version 1.0 implements `smtp` only; others are reserved for future adapters.
 */
export const NOTIFICATION_PROVIDER = {
  SMTP: "smtp",
  GOOGLE_WORKSPACE: "google_workspace",
  MICROSOFT_365: "microsoft_365",
  AMAZON_SES: "amazon_ses",
  SENDGRID: "sendgrid",
  MAILGUN: "mailgun",
  RESEND: "resend",
  FIREBASE_EXTENSIONS: "firebase_extensions",
} as const;

export type NotificationProviderId =
  (typeof NOTIFICATION_PROVIDER)[keyof typeof NOTIFICATION_PROVIDER];

export const NOTIFICATION_STATUS = {
  QUEUED: "queued",
  SENDING: "sending",
  SENT: "sent",
  FAILED: "failed",
} as const;

export type NotificationStatus =
  (typeof NOTIFICATION_STATUS)[keyof typeof NOTIFICATION_STATUS];

export const NOTIFICATION_TEMPLATE = {
  INVITATION: "invitation",
  COMPLETION: "completion",
} as const;

export type NotificationTemplateId =
  (typeof NOTIFICATION_TEMPLATE)[keyof typeof NOTIFICATION_TEMPLATE];

export interface NotificationRecord {
  id: string;
  channel: NotificationChannel;
  provider: NotificationProviderId;
  templateId: NotificationTemplateId;
  status: NotificationStatus;
  companyId: string;
  inviteId: string | null;
  sessionId: string | null;
  representativeId: string | null;
  to: string;
  subject: string;
  /** Server-only secure link for email retry — never exposed to clients via SDK. */
  secureLink: string | null;
  clientName: string | null;
  companyName: string | null;
  retryCount: number;
  failureReason: string | null;
  queuedAt: string;
  sentAt: string | null;
  failedAt: string | null;
  lastAttemptAt: string | null;
  providerMessageId: string | null;
}
