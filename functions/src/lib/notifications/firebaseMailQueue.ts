import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import { error as logError } from "firebase-functions/logger";
import { NOTIFICATION_PROVIDER } from "../../shared";
import { db } from "../firebase";
import type { EmailMessage, NotificationProvider, ProviderSendResult } from "./provider";

/**
 * Firebase Trigger Email extension (firestore-send-email) queue document.
 * Extension watches `mail/` and delivers — no SMTP in application code.
 *
 * Optional fields (replyTo, cc, bcc, attachments, …) must be omitted entirely
 * when empty — never write undefined or null.
 */
export interface FirebaseMailDocument {
  to: string[];
  message: {
    subject: string;
    text: string;
    html: string;
  };
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  /** Correlation fields (ignored by the extension). */
  inviteId?: string;
  sessionId?: string;
  companyId?: string;
  notificationId?: string;
  templateId?: string;
  createdAt?: string;
}

/** Drop undefined / null / empty-string optional properties recursively. */
export function omitUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => omitUndefinedDeep(item)) as T;
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (raw === undefined || raw === null) continue;
      if (typeof raw === "string" && raw.trim() === "") continue;
      out[key] = omitUndefinedDeep(raw);
    }
    return out as T;
  }
  return value;
}

/**
 * Build a Trigger Email–compatible mail payload with no undefined/null optionals.
 */
export function buildFirebaseMailPayload(
  doc: FirebaseMailDocument,
): Record<string, unknown> {
  const to = (Array.isArray(doc.to) ? doc.to : [doc.to])
    .map((addr) => String(addr || "").trim().toLowerCase())
    .filter(Boolean);
  if (to.length === 0) {
    throw new Error("mail.to requires at least one recipient.");
  }
  if (!doc.message?.subject?.trim()) {
    throw new Error("mail.message.subject is required.");
  }

  const payload: Record<string, unknown> = {
    to,
    message: {
      subject: doc.message.subject.trim(),
      text: doc.message.text || "",
      html: doc.message.html || "",
    },
    createdAt: doc.createdAt || new Date().toISOString(),
    createdAtServer: FieldValue.serverTimestamp(),
  };

  const replyTo = doc.replyTo?.trim();
  if (replyTo) payload.replyTo = replyTo;

  if (doc.cc && doc.cc.length > 0) {
    payload.cc = doc.cc.map((a) => String(a).trim()).filter(Boolean);
  }
  if (doc.bcc && doc.bcc.length > 0) {
    payload.bcc = doc.bcc.map((a) => String(a).trim()).filter(Boolean);
  }

  const inviteId = doc.inviteId?.trim();
  if (inviteId) payload.inviteId = inviteId;
  const sessionId = doc.sessionId?.trim();
  if (sessionId) payload.sessionId = sessionId;
  const companyId = doc.companyId?.trim();
  if (companyId) payload.companyId = companyId;
  const notificationId = doc.notificationId?.trim();
  if (notificationId) payload.notificationId = notificationId;
  const templateId = doc.templateId?.trim();
  if (templateId) payload.templateId = templateId;

  return omitUndefinedDeep(payload);
}

export async function enqueueFirebaseMail(
  doc: FirebaseMailDocument,
): Promise<{ mailId: string; ref: DocumentReference }> {
  const ref = db.collection("mail").doc();
  const payload = buildFirebaseMailPayload(doc);
  await ref.set(payload);
  return { mailId: ref.id, ref };
}

/**
 * Delivery adapter: writes to Firestore `mail/` for Trigger Email.
 * Never uses SMTP, nodemailer, or App Passwords.
 */
export class FirebaseMailQueueProvider implements NotificationProvider {
  readonly id = NOTIFICATION_PROVIDER.FIREBASE_EXTENSIONS;

  async sendEmail(message: EmailMessage): Promise<ProviderSendResult> {
    const to = (message.to || "").trim().toLowerCase();
    if (!to) {
      return { ok: false, failureReason: "Missing recipient email address." };
    }
    if (!message.subject?.trim()) {
      return { ok: false, failureReason: "Missing email subject." };
    }

    try {
      const mailInput: FirebaseMailDocument = {
        to: [to],
        message: {
          subject: message.subject,
          text: message.text,
          html: message.html,
        },
      };
      const replyTo = message.replyTo?.trim();
      if (replyTo) mailInput.replyTo = replyTo;

      const { mailId } = await enqueueFirebaseMail(mailInput);
      return {
        ok: true,
        providerMessageId: mailId,
      };
    } catch (err) {
      logError("Firebase mail queue write failed", err as Error);
      const detail =
        err instanceof Error ? err.message : "Unknown Firestore mail queue error";
      return {
        ok: false,
        failureReason: `Invitation email queued failed: ${detail}`,
      };
    }
  }
}

/** Probe recent mail docs for admin status (delivery.* written by extension). */
export async function probeFirebaseMailQueueHealth(): Promise<{
  status: "configured" | "not_configured" | "queue_healthy" | "queue_error";
  lastError: string | null;
  recentCount: number;
}> {
  const snap = await db
    .collection("mail")
    .orderBy("createdAtServer", "desc")
    .limit(20)
    .get()
    .catch(async () =>
      db.collection("mail").limit(20).get().catch(() => null),
    );

  if (!snap) {
    return { status: "not_configured", lastError: null, recentCount: 0 };
  }

  const recentCount = snap.size;
  let lastError: string | null = null;
  let hasSuccess = false;
  let hasError = false;

  for (const doc of snap.docs) {
    const data = doc.data();
    const delivery = data.delivery as
      | { state?: string; error?: string }
      | undefined;
    const state = (delivery?.state || "").toLowerCase();
    if (state === "error" || state === "failed") {
      hasError = true;
      lastError = delivery?.error || lastError || "Queue delivery error";
    }
    if (state === "success" || state === "pending") {
      hasSuccess = true;
    }
  }

  if (hasError) {
    return { status: "queue_error", lastError, recentCount };
  }
  if (recentCount > 0 || hasSuccess) {
    return { status: "queue_healthy", lastError: null, recentCount: 0 };
  }

  const portal = await db.collection("settings").doc("portal").get();
  const flagged = Boolean(portal.data()?.firebaseEmail?.configured);
  if (flagged) {
    return { status: "configured", lastError: null, recentCount: 0 };
  }
  return { status: "configured", lastError: null, recentCount: 0 };
}
