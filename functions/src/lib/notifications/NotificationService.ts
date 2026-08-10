import { FieldValue, type DocumentData, type DocumentReference } from "firebase-admin/firestore";
import { error as logError } from "firebase-functions/logger";
import {
  AUDIT_EVENT,
  INVITE_STATUS,
  NOTIFICATION_CHANNEL,
  NOTIFICATION_PROVIDER,
  NOTIFICATION_STATUS,
  NOTIFICATION_TEMPLATE,
  type NotificationPlatformSettings,
  type NotificationProviderId,
  type PortalSettings,
} from "../../shared";
import { writeAnalyticsEvent, writeAuditEvent } from "../audit";
import { db } from "../firebase";
import { getCompany, getPortalSettings } from "../settings";
import { buildInvitationEmailContent } from "./invitationEmailTemplate";
import { resolveInvitationBranding } from "./invitationBranding";
import { enqueueFirebaseMail } from "./firebaseMailQueue";

const DEFAULT_NOTIFICATION_SETTINGS: NotificationPlatformSettings = {
  defaultProvider: NOTIFICATION_PROVIDER.FIREBASE_EXTENSIONS,
  defaultSenderDisplayName: "Presentation Hub",
  defaultInvitationSubject: "Secure Presentation Invitation",
  defaultFooter: "Delivered securely by Presentation Hub.",
  defaultFromEmail: null,
};

export function notificationSettingsFromPortal(
  settings: PortalSettings,
): NotificationPlatformSettings {
  return {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...(settings.notifications || {}),
    // Version 0.1: always use Firebase Trigger Email mail queue.
    defaultProvider: NOTIFICATION_PROVIDER.FIREBASE_EXTENSIONS,
  };
}

export interface QueueInvitationEmailInput {
  companyId: string;
  inviteId: string;
  sessionId: string;
  representativeId: string;
  representativeName: string;
  clientName: string;
  clientEmail: string;
  secureLink: string;
}

export interface DispatchResult {
  notificationId: string;
  status: string;
  provider: NotificationProviderId;
  failureReason: string | null;
  inviteStatus: string;
  mailId?: string | null;
}

/**
 * NotificationService — queues invitation email via Firebase Trigger Email (`mail/`).
 * Never uses SMTP. Presentation creation must succeed even if queue write fails.
 */
export class NotificationService {
  async queueAndSendInvitationEmail(
    input: QueueInvitationEmailInput,
  ): Promise<DispatchResult> {
    const notificationId = await this.queueInvitationEmail(input);
    return this.dispatch(notificationId);
  }

  async queueInvitationEmail(input: QueueInvitationEmailInput): Promise<string> {
    const [company, portal] = await Promise.all([
      getCompany(input.companyId),
      getPortalSettings(),
    ]);
    const platform = notificationSettingsFromPortal(portal);
    const branding = resolveInvitationBranding(company, platform);

    const content = buildInvitationEmailContent({
      clientName: input.clientName,
      companyName: branding.companyName,
      representativeName: input.representativeName,
      secureLink: input.secureLink,
      primaryColor: branding.primaryColor,
      logoUrl: branding.logoUrl,
      footerText: branding.footerText,
      subject: branding.subject,
      replyToEmail: branding.replyToEmail,
    });

    const ref = db.collection("notifications").doc();
    const nowIso = new Date().toISOString();
    await ref.set({
      id: ref.id,
      channel: NOTIFICATION_CHANNEL.EMAIL,
      provider: NOTIFICATION_PROVIDER.FIREBASE_EXTENSIONS,
      templateId: NOTIFICATION_TEMPLATE.INVITATION,
      status: NOTIFICATION_STATUS.QUEUED,
      companyId: input.companyId,
      inviteId: input.inviteId,
      sessionId: input.sessionId,
      representativeId: input.representativeId,
      representativeName: input.representativeName,
      to: input.clientEmail,
      subject: content.subject,
      secureLink: input.secureLink,
      clientName: input.clientName,
      companyName: branding.companyName,
      fromDisplayName: branding.senderDisplayName,
      replyTo: branding.replyToEmail,
      primaryColor: branding.primaryColor,
      logoUrl: branding.logoUrl,
      footerText: branding.footerText,
      retryCount: 0,
      failureReason: null,
      queuedAt: nowIso,
      sentAt: null,
      failedAt: null,
      lastAttemptAt: null,
      providerMessageId: null,
      mailId: null,
      createdAtServer: FieldValue.serverTimestamp(),
      updatedAtServer: FieldValue.serverTimestamp(),
    });

    await db.collection("invites").doc(input.inviteId).update({
      lastNotificationId: ref.id,
      notificationStatus: NOTIFICATION_STATUS.QUEUED,
      notificationFailureReason: null,
      updatedAt: nowIso,
    });

    await writeAuditEvent({
      type: AUDIT_EVENT.NOTIFICATION_QUEUED,
      sessionId: input.sessionId,
      inviteId: input.inviteId,
      representativeId: input.representativeId,
      actorUid: input.representativeId,
      actorType: "representative",
      payload: {
        notificationId: ref.id,
        channel: NOTIFICATION_CHANNEL.EMAIL,
        provider: NOTIFICATION_PROVIDER.FIREBASE_EXTENSIONS,
        companyId: input.companyId,
        fromDisplayName: branding.senderDisplayName,
      },
    });

    return ref.id;
  }

  async dispatch(
    notificationId: string,
    opts?: { incrementRetry?: boolean },
  ): Promise<DispatchResult> {
    const ref = db.collection("notifications").doc(notificationId);
    const snap = await ref.get();
    if (!snap.exists) {
      return {
        notificationId,
        status: NOTIFICATION_STATUS.FAILED,
        provider: NOTIFICATION_PROVIDER.FIREBASE_EXTENSIONS,
        failureReason: "notification_not_found",
        inviteStatus: INVITE_STATUS.PENDING,
        mailId: null,
      };
    }

    const data = snap.data()!;
    if (data.status === NOTIFICATION_STATUS.SENT && data.mailId) {
      return {
        notificationId,
        status: NOTIFICATION_STATUS.SENT,
        provider: NOTIFICATION_PROVIDER.FIREBASE_EXTENSIONS,
        failureReason: null,
        inviteStatus: INVITE_STATUS.SENT,
        mailId: String(data.mailId),
      };
    }

    const nowIso = new Date().toISOString();
    const retryCount =
      Number(data.retryCount || 0) + (opts?.incrementRetry ? 1 : 0);
    const providerId = NOTIFICATION_PROVIDER.FIREBASE_EXTENSIONS;

    await ref.update({
      status: NOTIFICATION_STATUS.SENDING,
      lastAttemptAt: nowIso,
      retryCount,
      provider: providerId,
      updatedAtServer: FieldValue.serverTimestamp(),
    });

    if (!data.secureLink) {
      return this.markFailed(ref, data, {
        failureReason: "secure_link_missing",
        retryCount,
        nowIso,
        providerId,
      });
    }

    let fromDisplayName = String(data.fromDisplayName || "").trim();
    let replyTo = (data.replyTo as string | null) || null;
    let companyName = String(data.companyName || "").trim();
    try {
      const company = await getCompany(String(data.companyId || ""));
      const portal = await getPortalSettings();
      const branding = resolveInvitationBranding(
        company,
        notificationSettingsFromPortal(portal),
      );
      fromDisplayName = fromDisplayName || branding.senderDisplayName;
      replyTo = replyTo || branding.replyToEmail;
      companyName = companyName || branding.companyName;
    } catch {
      fromDisplayName = fromDisplayName || companyName || "Presentation Hub";
    }

    const content = buildInvitationEmailContent({
      clientName: String(data.clientName || ""),
      companyName: companyName || "Presentation Hub",
      representativeName: String(data.representativeName || ""),
      secureLink: String(data.secureLink || ""),
      primaryColor: (data.primaryColor as string | null) || null,
      logoUrl: (data.logoUrl as string | null) || null,
      footerText: (data.footerText as string | null) || null,
      subject: String(data.subject || ""),
      replyToEmail: replyTo,
    });

    let mailId: string;
    try {
      const mailDoc: import("./firebaseMailQueue").FirebaseMailDocument = {
        to: [String(data.to).trim().toLowerCase()],
        message: {
          subject: content.subject,
          text: content.text,
          html: content.html,
        },
        notificationId,
        templateId: NOTIFICATION_TEMPLATE.INVITATION,
        createdAt: nowIso,
      };
      const reply = replyTo?.trim();
      if (reply) mailDoc.replyTo = reply;
      const inviteIdVal = String(data.inviteId || "").trim();
      if (inviteIdVal) mailDoc.inviteId = inviteIdVal;
      const sessionIdVal = String(data.sessionId || "").trim();
      if (sessionIdVal) mailDoc.sessionId = sessionIdVal;
      const companyIdVal = String(data.companyId || "").trim();
      if (companyIdVal) mailDoc.companyId = companyIdVal;

      const queued = await enqueueFirebaseMail(mailDoc);
      mailId = queued.mailId;
    } catch (err) {
      logError("Firebase mail queue creation failed", err as Error);
      const detail =
        err instanceof Error ? err.stack || err.message : String(err);
      logError("Firebase mail queue error detail", { detail });
      return this.markFailed(ref, data, {
        failureReason: `Invitation email queued failed. ${
          err instanceof Error ? err.message : "Firestore mail write error"
        }`,
        retryCount,
        nowIso,
        providerId,
      });
    }

    await ref.update({
      status: NOTIFICATION_STATUS.SENT,
      sentAt: nowIso,
      failedAt: null,
      failureReason: null,
      fromDisplayName,
      replyTo: replyTo || null,
      providerMessageId: mailId,
      mailId,
      updatedAtServer: FieldValue.serverTimestamp(),
    });

    const inviteId = String(data.inviteId || "");
    const sessionId = String(data.sessionId || "");
    const representativeId = String(data.representativeId || "");

    if (inviteId) {
      await db.collection("invites").doc(inviteId).update({
        status: INVITE_STATUS.SENT,
        sentAt: nowIso,
        lastNotificationId: notificationId,
        notificationStatus: NOTIFICATION_STATUS.SENT,
        notificationFailureReason: null,
        updatedAt: nowIso,
      });
    }
    if (sessionId) {
      await db.collection("presentationSessions").doc(sessionId).update({
        "analytics.invitationSentAt": nowIso,
        updatedAt: nowIso,
        updatedAtServer: FieldValue.serverTimestamp(),
      });
    }

    await writeAuditEvent({
      type: AUDIT_EVENT.NOTIFICATION_SENT,
      sessionId: sessionId || undefined,
      inviteId: inviteId || undefined,
      representativeId: representativeId || undefined,
      actorUid: representativeId || undefined,
      actorType: "system",
      payload: {
        notificationId,
        provider: providerId,
        channel: data.channel,
        companyId: data.companyId,
        fromDisplayName,
        mailId,
        retryCount,
      },
    });
    await writeAuditEvent({
      type: AUDIT_EVENT.EMAIL_SENT,
      sessionId: sessionId || undefined,
      inviteId: inviteId || undefined,
      representativeId: representativeId || undefined,
      actorUid: representativeId || undefined,
      actorType: "system",
      payload: {
        template: NOTIFICATION_TEMPLATE.INVITATION,
        notificationId,
        provider: providerId,
        to: data.to,
        fromDisplayName,
        mailId,
      },
    });
    await writeAuditEvent({
      type: AUDIT_EVENT.INVITATION_SENT,
      sessionId: sessionId || undefined,
      inviteId: inviteId || undefined,
      representativeId: representativeId || undefined,
      actorUid: representativeId || undefined,
      actorType: "representative",
      payload: {
        companyId: data.companyId,
        notificationId,
        provider: providerId,
        mailId,
      },
    });
    if (sessionId && representativeId) {
      await writeAnalyticsEvent({
        sessionId,
        representativeId,
        metric: "invitation_sent",
        value: nowIso,
      });
    }

    return {
      notificationId,
      status: NOTIFICATION_STATUS.SENT,
      provider: providerId,
      failureReason: null,
      inviteStatus: INVITE_STATUS.SENT,
      mailId,
    };
  }

  private async markFailed(
    ref: DocumentReference,
    data: DocumentData,
    input: {
      failureReason: string;
      retryCount: number;
      nowIso: string;
      providerId: NotificationProviderId;
    },
  ): Promise<DispatchResult> {
    await ref.update({
      status: NOTIFICATION_STATUS.FAILED,
      failedAt: input.nowIso,
      failureReason: input.failureReason,
      retryCount: input.retryCount,
      updatedAtServer: FieldValue.serverTimestamp(),
    });

    const inviteId = String(data.inviteId || "");
    const sessionId = String(data.sessionId || "");
    const representativeId = String(data.representativeId || "");

    if (inviteId) {
      await db.collection("invites").doc(inviteId).update({
        lastNotificationId: ref.id,
        notificationStatus: NOTIFICATION_STATUS.FAILED,
        notificationFailureReason: input.failureReason,
        updatedAt: input.nowIso,
      });
    }

    await writeAuditEvent({
      type: AUDIT_EVENT.NOTIFICATION_FAILED,
      sessionId: sessionId || undefined,
      inviteId: inviteId || undefined,
      representativeId: representativeId || undefined,
      actorUid: representativeId || undefined,
      actorType: "system",
      payload: {
        notificationId: ref.id,
        provider: input.providerId,
        failureReason: input.failureReason,
        retryCount: input.retryCount,
        companyId: data.companyId,
      },
    });
    await writeAuditEvent({
      type: AUDIT_EVENT.EMAIL_FAILED,
      sessionId: sessionId || undefined,
      inviteId: inviteId || undefined,
      representativeId: representativeId || undefined,
      actorUid: representativeId || undefined,
      actorType: "system",
      payload: {
        template: NOTIFICATION_TEMPLATE.INVITATION,
        notificationId: ref.id,
        provider: input.providerId,
        failureReason: input.failureReason,
      },
    });

    return {
      notificationId: ref.id,
      status: NOTIFICATION_STATUS.FAILED,
      provider: input.providerId,
      failureReason: input.failureReason,
      inviteStatus: INVITE_STATUS.PENDING,
      mailId: null,
    };
  }
}

export const notificationService = new NotificationService();
