import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { AUDIT_EVENT, PERMISSIONS } from "../shared";
import { assertHasPermission, loadStaffContext } from "../lib/authz";
import { writeAuditEvent } from "../lib/audit";
import { db } from "../lib/firebase";
import { getPortalSettings } from "../lib/settings";
import {
  enqueueFirebaseMail,
  probeFirebaseMailQueueHealth,
} from "../lib/notifications/firebaseMailQueue";

/**
 * Staff-safe email status — Firebase Trigger Email (no SMTP secrets).
 */
export const getActingCompanyEmailStatus = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.DASHBOARD_READ);

  let companyId = ctx.companyId;
  if (ctx.isPlatformAdmin && !companyId) {
    const settings = await getPortalSettings();
    companyId = settings.defaultCompanyId || null;
  }

  const portal = await getPortalSettings();
  const health = await probeFirebaseMailQueueHealth();
  const configured =
    Boolean(portal.firebaseEmail?.configured) || health.recentCount > 0;

  let displayEmailName: string | null = null;
  if (companyId) {
    const snap = await db.collection("companies").doc(companyId).get();
    if (snap.exists) {
      const c = snap.data()!;
      displayEmailName =
        (c.displayEmailName as string) || (c.name as string) || null;
    }
  }

  return {
    companyId,
    emailConfigured: configured,
    connectionStatus: configured
      ? health.status === "queue_error"
        ? "queue_error"
        : health.status === "queue_healthy"
          ? "queue_healthy"
          : "configured"
      : "not_configured",
    displayEmailName,
    canConfigure: ctx.isPlatformAdmin,
    provider: "Firebase Email",
  };
});

/** Admin: Firebase Email settings (no App Passwords / SMTP). */
export const getCompanyEmailSettings = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.COMPANIES_MANAGE);
  if (!ctx.isPlatformAdmin) {
    throw new HttpsError("permission-denied", "Platform administrator required.");
  }

  const companyId = String(request.data?.companyId || "").trim() || "serenity-1";
  const snap = await db.collection("companies").doc(companyId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Company not found.");
  const company = snap.data()!;
  const portal = await getPortalSettings();
  const health = await probeFirebaseMailQueueHealth();
  const configured =
    Boolean(portal.firebaseEmail?.configured) || health.recentCount > 0;

  return {
    companyId,
    companyName: company.name || "",
    displayEmailName: company.displayEmailName || company.name || "",
    provider: "Firebase Email",
    extension: "Trigger Email (firestore-send-email)",
    collection: "mail",
    emailConfigured: configured,
    connectionStatus: configured
      ? health.status === "queue_error"
        ? "queue_error"
        : "configured"
      : "not_configured",
    lastError: health.lastError,
    recentCount: health.recentCount,
    // Legacy fields cleared — SMTP removed.
    gmailAddress: "",
    replyToEmail: company.replyToEmail || "",
    hasAppPassword: false,
  };
});

/**
 * Mark Firebase Trigger Email as configured (after extension install).
 * Optionally save company display name / reply-to for branding.
 */
export const saveCompanyEmailSettings = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.COMPANIES_MANAGE);
  if (!ctx.isPlatformAdmin) {
    throw new HttpsError("permission-denied", "Platform administrator required.");
  }

  const companyId = String(request.data?.companyId || "").trim();
  const displayEmailName = String(request.data?.displayEmailName || "").trim();
  const replyToEmail = String(request.data?.replyToEmail || "").trim();
  if (!companyId) throw new HttpsError("invalid-argument", "companyId required.");

  const ref = db.collection("companies").doc(companyId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Company not found.");

  const iso = new Date().toISOString();
  const updates: Record<string, unknown> = {
    updatedAt: iso,
    updatedAtServer: FieldValue.serverTimestamp(),
    // Clear legacy SMTP flags from company docs.
    emailConfigured: true,
    emailConnectionStatus: "configured",
    emailLastError: null,
    smtpGmailAddress: FieldValue.delete(),
  };
  if (displayEmailName) updates.displayEmailName = displayEmailName;
  if (replyToEmail || request.data?.replyToEmail === "") {
    updates.replyToEmail = replyToEmail || null;
  }

  await ref.update(updates);
  await db.collection("settings").doc("portal").set(
    {
      firebaseEmail: {
        configured: true,
        configuredAt: iso,
        configuredBy: ctx.uid,
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await writeAuditEvent({
    type: AUDIT_EVENT.ADMINISTRATOR_ACTION,
    actorUid: ctx.uid,
    actorType: "administrator",
    payload: {
      action: "firebase_email_marked_configured",
      companyId,
    },
  });

  return {
    ok: true,
    companyId,
    emailConfigured: true,
    connectionStatus: "configured",
    provider: "Firebase Email",
  };
});

/** Queue a test email via Firebase mail/ (no SMTP). */
export const testCompanyEmail = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.COMPANIES_MANAGE);
  if (!ctx.isPlatformAdmin) {
    throw new HttpsError("permission-denied", "Platform administrator required.");
  }

  const companyId = String(request.data?.companyId || "").trim() || "serenity-1";
  const to =
    String(request.data?.to || "").trim().toLowerCase() ||
    (ctx.profile.email || "").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new HttpsError("invalid-argument", "Valid test recipient email required.");
  }

  const snap = await db.collection("companies").doc(companyId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Company not found.");
  const companyName =
    String(snap.data()?.displayEmailName || snap.data()?.name || "Presentation Hub");

  try {
    const { mailId } = await enqueueFirebaseMail({
      to: [to],
      message: {
        subject: `Presentation Hub test — ${companyName}`,
        text: [
          "This is a test email from Presentation Hub.",
          `Company: ${companyName}`,
          `Queued at: ${new Date().toISOString()}`,
          "Delivered by Firebase Trigger Email (mail queue).",
        ].join("\n"),
        html: `<p>This is a test email from <strong>Presentation Hub</strong>.</p>
          <p>Company: ${companyName}</p>
          <p>Delivered by Firebase Trigger Email (mail queue).</p>`,
      },
      companyId,
      templateId: "test",
    });

    const iso = new Date().toISOString();
    await snap.ref.update({
      emailConnectionStatus: "connected",
      emailLastTestAt: iso,
      emailLastError: null,
      updatedAt: iso,
    });
    await db.collection("settings").doc("portal").set(
      {
        firebaseEmail: {
          configured: true,
          lastTestAt: iso,
          lastTestMailId: mailId,
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      ok: true,
      failureReason: null,
      connectionStatus: "configured",
      sentTo: to,
      mailId,
      message: "Email queued successfully.",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "mail_queue_failed";
    await snap.ref.update({
      emailConnectionStatus: "queue_error",
      emailLastError: msg,
      emailLastTestAt: new Date().toISOString(),
    });
    throw new HttpsError("failed-precondition", msg);
  }
});
