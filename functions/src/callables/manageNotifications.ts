import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  AUDIT_EVENT,
  NOTIFICATION_PROVIDER,
  PERMISSIONS,
  type NotificationPlatformSettings,
  type NotificationProviderId,
} from "../shared";
import {
  assertHasPermission,
  loadStaffContext,
} from "../lib/authz";
import { writeAuditEvent } from "../lib/audit";
import { db } from "../lib/firebase";
import { getPortalSettings } from "../lib/settings";
import { notificationSettingsFromPortal } from "../lib/notifications/NotificationService";
import { probeFirebaseMailQueueHealth } from "../lib/notifications/firebaseMailQueue";

const ALLOWED_PROVIDERS = new Set<string>([
  NOTIFICATION_PROVIDER.FIREBASE_EXTENSIONS,
]);

/** Platform admin: notification defaults + Firebase Email queue status. */
export const getNotificationSettings = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.SETTINGS_MANAGE);

  const portal = await getPortalSettings();
  const notifications = notificationSettingsFromPortal(portal);
  const health = await probeFirebaseMailQueueHealth();
  const configured = Boolean(portal.firebaseEmail?.configured) || health.recentCount > 0;

  return {
    notifications: {
      ...notifications,
      defaultProvider: NOTIFICATION_PROVIDER.FIREBASE_EXTENSIONS,
    },
    firebaseEmail: {
      provider: "Firebase Email",
      extension: "Trigger Email (firestore-send-email)",
      collection: "mail",
      status: configured
        ? health.status === "queue_error"
          ? "queue_error"
          : health.status === "queue_healthy"
            ? "queue_healthy"
            : "configured"
        : "not_configured",
      lastError: health.lastError,
      recentCount: health.recentCount,
    },
    providerReady: {
      firebaseEmail: configured,
      smtp: false,
    },
    availableProviders: [NOTIFICATION_PROVIDER.FIREBASE_EXTENSIONS],
  };
});

/** Platform admin: update invitation template defaults (not SMTP). */
export const updateNotificationSettings = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.SETTINGS_MANAGE);
  if (!ctx.isPlatformAdmin) {
    throw new HttpsError("permission-denied", "Platform administrator required.");
  }

  const current = notificationSettingsFromPortal(await getPortalSettings());
  const patch: NotificationPlatformSettings = {
    ...current,
    defaultProvider: NOTIFICATION_PROVIDER.FIREBASE_EXTENSIONS,
  };

  if (typeof request.data?.defaultProvider === "string") {
    const provider = request.data.defaultProvider as NotificationProviderId;
    if (!ALLOWED_PROVIDERS.has(provider)) {
      throw new HttpsError(
        "invalid-argument",
        "Only Firebase Email (Trigger Email) is supported in Version 0.1.",
      );
    }
  }
  if (typeof request.data?.defaultSenderDisplayName === "string") {
    patch.defaultSenderDisplayName = request.data.defaultSenderDisplayName
      .trim()
      .slice(0, 120);
  }
  if (typeof request.data?.defaultInvitationSubject === "string") {
    patch.defaultInvitationSubject = request.data.defaultInvitationSubject
      .trim()
      .slice(0, 200);
  }
  if (typeof request.data?.defaultFooter === "string") {
    patch.defaultFooter = request.data.defaultFooter.trim().slice(0, 500);
  }

  const markConfigured = request.data?.markFirebaseEmailConfigured === true;

  await db.collection("settings").doc("portal").set(
    {
      notifications: patch,
      ...(markConfigured
        ? {
            firebaseEmail: {
              configured: true,
              configuredAt: new Date().toISOString(),
              configuredBy: ctx.uid,
            },
          }
        : {}),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await writeAuditEvent({
    type: AUDIT_EVENT.ADMINISTRATOR_ACTION,
    actorUid: ctx.uid,
    actorType: "administrator",
    payload: {
      action: "notification_settings_updated",
      defaultProvider: patch.defaultProvider,
      markFirebaseEmailConfigured: markConfigured,
    },
  });

  const health = await probeFirebaseMailQueueHealth();
  return {
    notifications: patch,
    firebaseEmail: {
      provider: "Firebase Email",
      status: markConfigured || health.recentCount > 0 ? "configured" : "not_configured",
      lastError: health.lastError,
      recentCount: health.recentCount,
    },
    providerReady: { firebaseEmail: true, smtp: false },
  };
});
