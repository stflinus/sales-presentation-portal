import { createHmac, timingSafeEqual } from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../firebase";
import { DefaultCalendarService } from "./CalendarService";
import { GoogleCalendarProvider } from "./GoogleCalendarProvider";
import { decryptSecret, encryptSecret } from "./tokenCrypto";
import {
  googleClientSecret,
  scopeIncludesCalendar,
  scopeIncludesGmail,
} from "../google/googleOAuthConfig";
import { sendGmailMessage } from "../google/gmailSend";
import { buildInvitationEmailContent } from "../notifications/invitationEmailTemplate";
import { resolveInvitationBranding } from "../notifications/invitationBranding";
import { notificationSettingsFromPortal } from "../notifications/NotificationService";
import { getCompany, getPortalSettings } from "../settings";

function calendarService() {
  return new DefaultCalendarService(
    new Map([["google", new GoogleCalendarProvider()]]),
  );
}

export async function loadOwnGoogleConnection(
  uid: string,
): Promise<Record<string, unknown> | null> {
  const snap = await db.collection("calendarConnections").doc(uid).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data()! };
}

/** @deprecated use loadOwnGoogleConnection */
export const loadOwnCalendarConnection = loadOwnGoogleConnection;

export async function ensureGoogleAccessToken(uid: string): Promise<string> {
  const conn = await loadOwnGoogleConnection(uid);
  if (!conn || !conn.encryptedAccessToken) {
    throw new HttpsError(
      "failed-precondition",
      "Google is not connected. Connect Google from the Dashboard.",
    );
  }
  const expiresAt = Number(conn.accessTokenExpiresAt || 0);
  if (expiresAt > Date.now() + 60_000) {
    return decryptSecret(String(conn.encryptedAccessToken));
  }
  if (!conn.encryptedRefreshToken) {
    throw new HttpsError(
      "failed-precondition",
      "Google authorization expired. Reconnect Google.",
    );
  }
  const provider = calendarService().defaultProvider();
  try {
    const refreshed = await provider.refreshAccessToken(
      decryptSecret(String(conn.encryptedRefreshToken)),
    );
    await db.collection("calendarConnections").doc(uid).update({
      encryptedAccessToken: encryptSecret(refreshed.accessToken),
      accessTokenExpiresAt: refreshed.expiresAt,
      updatedAt: new Date().toISOString(),
      updatedAtServer: FieldValue.serverTimestamp(),
    });
    return refreshed.accessToken;
  } catch {
    throw new HttpsError(
      "failed-precondition",
      "Google authorization expired. Reconnect Google.",
    );
  }
}

/** @deprecated use ensureGoogleAccessToken */
export const ensureCalendarAccessToken = ensureGoogleAccessToken;

export function googleConnectionCapabilities(
  conn: Record<string, unknown> | null,
): {
  connected: boolean;
  gmail: boolean;
  calendar: boolean;
  needsReconnect: boolean;
  email: string | null;
  scope: string | null;
} {
  if (!conn) {
    return {
      connected: false,
      gmail: false,
      calendar: false,
      needsReconnect: false,
      email: null,
      scope: null,
    };
  }
  const scope = String(conn.scope || "");
  const needsReconnect =
    !conn.encryptedRefreshToken ||
    (Number(conn.accessTokenExpiresAt || 0) < Date.now() &&
      !conn.encryptedRefreshToken);
  return {
    connected: true,
    gmail: scopeIncludesGmail(scope),
    calendar: scopeIncludesCalendar(scope),
    needsReconnect: Boolean(needsReconnect),
    email: conn.email ? String(conn.email) : null,
    scope: scope || null,
  };
}

/**
 * Best-effort: create/update one Google Calendar event for a Presentation follow-up.
 */
export async function syncFollowUpCalendarEvent(input: {
  uid: string;
  presentationId: string;
  clientName: string;
  scheduledAtIso: string;
  existingEventId?: string | null;
  notes?: string;
}): Promise<string | null> {
  try {
    const conn = await loadOwnGoogleConnection(input.uid);
    const caps = googleConnectionCapabilities(conn);
    if (!caps.connected || !caps.calendar || caps.needsReconnect) return null;
    const accessToken = await ensureGoogleAccessToken(input.uid);
    const provider = calendarService().defaultProvider() as GoogleCalendarProvider;
    const start = new Date(input.scheduledAtIso);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    return await provider.upsertEvent(accessToken, {
      eventId: input.existingEventId,
      summary: `Follow-up: ${input.clientName}`,
      description: [
        `Presentation ID: ${input.presentationId}`,
        input.notes || "",
      ]
        .filter(Boolean)
        .join("\n"),
      startIso: start.toISOString(),
      endIso: end.toISOString(),
    });
  } catch {
    return null;
  }
}

export async function deleteFollowUpCalendarEvent(input: {
  uid: string;
  eventId?: string | null;
}): Promise<void> {
  const eventId = (input.eventId || "").trim();
  if (!eventId) return;
  try {
    const accessToken = await ensureGoogleAccessToken(input.uid);
    const provider = calendarService().defaultProvider() as GoogleCalendarProvider;
    await provider.deleteEvent(accessToken, eventId);
  } catch {
    // best-effort
  }
}

export interface GmailInviteSendInput {
  representativeId: string;
  companyId: string;
  clientName: string;
  clientEmail: string;
  representativeName: string;
  secureLink: string;
}

export async function sendInvitationViaGmail(input: GmailInviteSendInput): Promise<{
  ok: boolean;
  messageId: string | null;
  failureReason: string | null;
  fromEmail: string | null;
}> {
  const conn = await loadOwnGoogleConnection(input.representativeId);
  const caps = googleConnectionCapabilities(conn);
  if (!caps.connected) {
    return {
      ok: false,
      messageId: null,
      failureReason: "Google is not connected.",
      fromEmail: null,
    };
  }
  if (caps.needsReconnect) {
    return {
      ok: false,
      messageId: null,
      failureReason: "Google authorization expired. Reconnect Google.",
      fromEmail: caps.email,
    };
  }
  if (!caps.gmail) {
    return {
      ok: false,
      messageId: null,
      failureReason: "Reconnect Google to grant Gmail send permission.",
      fromEmail: caps.email,
    };
  }
  if (!caps.email) {
    return {
      ok: false,
      messageId: null,
      failureReason: "Connected Google account has no email.",
      fromEmail: null,
    };
  }

  try {
    const accessToken = await ensureGoogleAccessToken(input.representativeId);
    const [company, portal] = await Promise.all([
      getCompany(input.companyId),
      getPortalSettings(),
    ]);
    const branding = resolveInvitationBranding(
      company,
      notificationSettingsFromPortal(portal),
    );
    const content = buildInvitationEmailContent({
      clientName: input.clientName,
      companyName: branding.companyName,
      representativeName: input.representativeName,
      secureLink: input.secureLink,
      primaryColor: branding.primaryColor,
      logoUrl: branding.logoUrl,
      footerText: branding.footerText,
      subject: "Secure Presentation Invitation",
      replyToEmail: branding.replyToEmail,
    });

    const result = await sendGmailMessage({
      accessToken,
      to: input.clientEmail,
      fromEmail: caps.email,
      fromDisplayName: branding.senderDisplayName || branding.companyName,
      subject: content.subject,
      text: content.text,
      html: content.html,
      replyTo: branding.replyToEmail,
    });

    return {
      ok: result.ok,
      messageId: result.messageId,
      failureReason: result.failureReason,
      fromEmail: caps.email,
    };
  } catch (err) {
    return {
      ok: false,
      messageId: null,
      failureReason:
        err instanceof Error
          ? err.message
          : "Email delivery failed.",
      fromEmail: caps.email,
    };
  }
}

export function calendarStateSecret(): string {
  return (
    process.env.GOOGLE_CALENDAR_TOKEN_KEY?.trim() ||
    googleClientSecret() ||
    "dev-insecure-oauth-state"
  );
}

export function signCalendarOAuthState(uid: string): string {
  const exp = Date.now() + 15 * 60 * 1000;
  const payload = `${uid}.${exp}`;
  const sig = createHmac("sha256", calendarStateSecret())
    .update(payload)
    .digest("hex");
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

export function verifyCalendarOAuthState(state: string): string {
  const raw = Buffer.from(state, "base64url").toString("utf8");
  const [uid, expStr, sig] = raw.split(".");
  if (!uid || !expStr || !sig) throw new Error("Invalid OAuth state.");
  const payload = `${uid}.${expStr}`;
  const expected = createHmac("sha256", calendarStateSecret())
    .update(payload)
    .digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Invalid OAuth state signature.");
  }
  if (Date.now() > Number(expStr)) throw new Error("OAuth state expired.");
  return uid;
}
