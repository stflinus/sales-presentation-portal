import type { NotificationProviderId } from "../../shared";

export interface EmailMessage {
  to: string;
  /** Display name shown as From (e.g. company name). */
  fromDisplayName: string;
  subject: string;
  text: string;
  html: string;
  /** Optional Reply-To (representative email). */
  replyTo?: string | null;
}

export interface ProviderSendResult {
  ok: boolean;
  providerMessageId?: string | null;
  failureReason?: string | null;
  /** Classified SMTP connection outcome for admin UI. */
  connectionStatus?:
    | "authentication_failed"
    | "connection_failed"
    | "connected"
    | null;
}

/** Channel-agnostic delivery adapter. Invitation logic never imports a concrete vendor. */
export interface NotificationProvider {
  readonly id: NotificationProviderId;
  sendEmail(message: EmailMessage): Promise<ProviderSendResult>;
}
