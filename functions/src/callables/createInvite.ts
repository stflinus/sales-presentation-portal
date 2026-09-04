import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  ACTIVITY_EVENT,
  ACTIVITY_SEVERITY,
  APP_VERSION,
  AUDIT_EVENT,
  CONTACT_STATUS,
  FOLLOWUP_REMINDER_STATUS,
  FOLLOWUP_STATUS,
  INVITE_STATUS,
  PERMISSIONS,
  SESSION_STATUS,
} from "../shared";
import {
  assertHasPermission,
  loadStaffContext,
  resolveActingCompanyId,
} from "../lib/authz";
import { writeAuditEvent } from "../lib/audit";
import { writePresentationActivity } from "../lib/presentationActivity";
import { generateInviteToken, hashToken } from "../lib/crypto";
import { db } from "../lib/firebase";
import { resolveAppOrigin } from "../lib/appOrigin";
import { assertProductionContentReady } from "../lib/productionContent";
import {
  expiresAtTimestamp,
  REP_PRESENTATION_CONFIG_ERROR,
  resolveInvitationPolicy,
} from "../lib/presentationPolicy";
import { getCompany, getPortalSettings } from "../lib/settings";
import { clientIpFromRequest } from "../lib/ua";
import { accessPolicySummary } from "../shared";

interface CreateInviteRequest {
  /** Existing contact — preferred. */
  contactId?: string;
  /** Used when creating a new contact inline. */
  clientName?: string;
  clientEmail?: string;
  /**
   * Intentionally omitted: accessPolicy / accessDurationDays / videoId.
   * Policy is always inherited from the rep's owner-assigned presentationSettings
   * via resolveInvitationPolicy and snapshotted onto the invite/session.
   */
}

/**
 * Create invitation for a Contact.
 * Access policy is resolved server-side from the acting representative's
 * administrator-assigned presentation settings — reps cannot override it here.
 */
export const createInvite = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.INVITES_CREATE);

  const data = request.data as CreateInviteRequest;
  let contactId = String(data.contactId || "").trim();
  let clientName = String(data.clientName || "").trim();
  let clientEmail = String(data.clientEmail || "").trim().toLowerCase();

  let requestedCompanyId: string | null = null;
  if (ctx.isPlatformAdmin) {
    const settings = await getPortalSettings();
    requestedCompanyId = ctx.companyId || settings.defaultCompanyId || null;
  }
  const companyId = resolveActingCompanyId(ctx, requestedCompanyId);
  await assertProductionContentReady(companyId);
  let policy;
  try {
    policy = await resolveInvitationPolicy({
      profile: ctx.profile,
      companyId,
    });
  } catch (err) {
    if (err instanceof HttpsError && err.code === "failed-precondition") {
      await writeAuditEvent({
        type: AUDIT_EVENT.REPRESENTATIVE_ACTION,
        actorUid: ctx.uid,
        actorType: "representative",
        payload: {
          action: "invite_blocked_presentation_config",
          companyId,
          reason: err.message,
        },
      });
      throw new HttpsError("failed-precondition", REP_PRESENTATION_CONFIG_ERROR);
    }
    throw err;
  }
  const videoId = policy.videoId;
  const expiresAt = expiresAtTimestamp(policy.expiresAt);

  const uid = ctx.uid;
  const nowIso = new Date().toISOString();


  if (contactId) {
    const contactSnap = await db.collection("contacts").doc(contactId).get();
    if (!contactSnap.exists) {
      throw new HttpsError("not-found", "Contact not found.");
    }
    const contact = contactSnap.data()!;
    if (contact.companyId !== companyId) {
      throw new HttpsError("permission-denied", "Contact company mismatch.");
    }
    if (
      contact.status === CONTACT_STATUS.ARCHIVED ||
      contact.status === CONTACT_STATUS.DELETED
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Cannot invite an archived or deleted contact.",
      );
    }
    if (
      !ctx.isPlatformAdmin &&
      !ctx.permissions.includes(PERMISSIONS.CONTACTS_MANAGE_COMPANY) &&
      contact.ownerRepresentativeId !== uid
    ) {
      throw new HttpsError(
        "permission-denied",
        "Representatives may only invite their own contacts.",
      );
    }
    clientName = String(contact.displayName || clientName);
    clientEmail = String(contact.email || clientEmail).toLowerCase();
  } else {
    if (!clientName || clientName.length > 200) {
      throw new HttpsError("invalid-argument", "Valid contact name required.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
      throw new HttpsError("invalid-argument", "Valid contact email required.");
    }
    assertHasPermission(ctx, PERMISSIONS.CONTACTS_MANAGE_OWN);
    const contactRef = db.collection("contacts").doc();
    contactId = contactRef.id;
    await contactRef.set({
      id: contactId,
      displayName: clientName,
      email: clientEmail,
      phone: null,
      companyId,
      ownerRepresentativeId: uid,
      status: CONTACT_STATUS.LEAD,
      notes: "",
      createdAt: nowIso,
      createdBy: uid,
      updatedAt: nowIso,
      updatedBy: uid,
      archivedAt: null,
      archivedBy: null,
      deletedAt: null,
      deletedBy: null,
      lastInvitedAt: null,
      lastSessionId: null,
      lastInviteId: null,
      createdAtServer: FieldValue.serverTimestamp(),
      updatedAtServer: FieldValue.serverTimestamp(),
    });
    await writeAuditEvent({
      type: AUDIT_EVENT.CONTACT_CREATED,
      representativeId: uid,
      actorUid: uid,
      actorType: "representative",
      payload: { contactId, companyId, email: clientEmail, displayName: clientName },
    });
  }

  const representativeName =
    ctx.profile.displayName ||
    (request.auth?.token?.name as string) ||
    (request.auth?.token?.email as string) ||
    "Representative";
  const representativeEmail =
    String(ctx.profile.email || request.auth?.token?.email || "").trim() || null;
  const representativeTitle = String(ctx.profile.title || "").trim() || null;
  const representativePhone = String(ctx.profile.phone || "").trim() || null;

  const token = generateInviteToken();
  const tokenHash = hashToken(token);

  const origin = resolveAppOrigin(
    (request.rawRequest?.headers.origin as string | undefined) || null,
  );
  if (!origin) {
    throw new HttpsError(
      "failed-precondition",
      "APP_ORIGIN is not configured; cannot build secure invitation link.",
    );
  }
  const inviteUrl = `${origin}/i/${token}`;
  const company = await getCompany(companyId);
  const companyName =
    String(company.displayEmailName || company.name || "").trim() ||
    "Presentation Hub";

  const inviteRef = db.collection("invites").doc();
  const sessionRef = db.collection("presentationSessions").doc();
  const ip = clientIpFromRequest(request.rawRequest?.headers["x-forwarded-for"]);

  const invite = {
    id: inviteRef.id,
    tokenHash,
    createdBy: uid,
    representativeName,
    clientName,
    clientEmail,
    status: INVITE_STATUS.PENDING,
    expiresAt: policy.expiresAt,
    sessionId: sessionRef.id,
    videoId,
    companyId,
    contactId,
    accessPolicy: policy.accessPolicy,
    accessDurationDays: policy.accessDurationDays,
    policyAppliedAt: policy.policyAppliedAt,
    viewingEntitlementConsumed: false,
    createdAt: nowIso,
    sentAt: null as string | null,
    lastNotificationId: null as string | null,
    notificationStatus: null as string | null,
    notificationFailureReason: null as string | null,
  };

  const session = {
    id: sessionRef.id,
    inviteId: inviteRef.id,
    representativeId: uid,
    representativeName,
    clientName,
    clientEmail,
    status: SESSION_STATUS.PENDING,
    videoId,
    companyId,
    companyName,
    contactId,
    maxWatchedSeconds: 0,
    completionPercent: 0,
    expiresAt: policy.expiresAt,
    representativeNotes: "",
    followUpStatus: FOLLOWUP_STATUS.NONE,
    followUpAt: null as string | null,
    followUpDate: null as string | null,
    followUpTime: null as string | null,
    followUpCalendarEventId: null as string | null,
    followUpReminderStatus: FOLLOWUP_REMINDER_STATUS.NONE,
    followUpNotes: null as string | null,
    /** Same secure invitation URL used by /i/{token} — for staff copy/share. */
    inviteUrl,
    healthStatus: "healthy" as const,
    healthSummary: "No issues detected.",
    healthUpdatedAt: nowIso,
    accessPolicy: policy.accessPolicy,
    accessDurationDays: policy.accessDurationDays,
    policyAppliedAt: policy.policyAppliedAt,
    viewingEntitlementConsumed: false,
    analytics: {
      representativeId: uid,
      videoVersionId: videoId,
    },
    /** Inactivity cleanup clock starts at invite creation until first client action. */
    lastMeaningfulClientActivityAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
    appVersion: APP_VERSION,
  };

  await db.runTransaction(async (tx) => {
    tx.set(inviteRef, {
      ...invite,
      createdAtServer: FieldValue.serverTimestamp(),
      expiresAtServer: expiresAt,
    });
    tx.set(sessionRef, {
      ...session,
      createdAtServer: FieldValue.serverTimestamp(),
      updatedAtServer: FieldValue.serverTimestamp(),
      expiresAtServer: expiresAt,
    });
    tx.update(db.collection("contacts").doc(contactId), {
      status: CONTACT_STATUS.INVITED,
      lastInvitedAt: nowIso,
      lastInviteId: inviteRef.id,
      lastSessionId: sessionRef.id,
      updatedAt: nowIso,
      updatedBy: uid,
      updatedAtServer: FieldValue.serverTimestamp(),
    });
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.INVITATION_CREATED,
    sessionId: sessionRef.id,
    inviteId: inviteRef.id,
    representativeId: uid,
    actorUid: uid,
    actorType: "representative",
    ipAddress: ip,
    payload: { clientName, clientEmail, videoId, companyId, contactId, accessPolicy: policy.accessPolicy },
  });

  await writePresentationActivity({
    sessionId: sessionRef.id,
    inviteId: inviteRef.id,
    companyId,
    representativeId: uid,
    type: ACTIVITY_EVENT.INVITATION_CREATED,
    severity: ACTIVITY_SEVERITY.SUCCESS,
    description: `Secure invitation created for ${clientName} <${clientEmail}>.`,
    ipAddress: ip,
    actorType: "representative",
    actorUid: uid,
    payload: { videoId, contactId, accessPolicy: policy.accessPolicy },
  });

  await writePresentationActivity({
    sessionId: sessionRef.id,
    inviteId: inviteRef.id,
    companyId,
    representativeId: uid,
    type: ACTIVITY_EVENT.PRESENTATION_POLICY_APPLIED,
    severity: ACTIVITY_SEVERITY.INFO,
    description: `Assigned video and ${accessPolicySummary(policy.accessPolicy, policy.accessDurationDays)} policy snapshotted for this invitation.`,
    ipAddress: ip,
    actorType: "system",
    payload: {
      videoId,
      accessPolicy: policy.accessPolicy,
      accessDurationDays: policy.accessDurationDays,
      expiresAt: policy.expiresAt,
    },
  });

  /**
   * Version 0.1: manual invitation workflow only.
   * Email delivery is deferred to Copy Link / Open Email in the UI.
   * (V0.2 may re-enable Gmail via Google Workspace.)
   */
  return {
    inviteId: inviteRef.id,
    sessionId: sessionRef.id,
    contactId,
    companyId,
    companyName,
    representativeName,
    representativeEmail,
    representativeTitle,
    representativePhone,
    clientName,
    clientEmail,
    inviteUrl,
    notificationId: null,
    notificationStatus: "manual",
    notificationProvider: null,
    failureReason: null,
    inviteStatus: INVITE_STATUS.PENDING,
    mailId: null,
    expiresAt: invite.expiresAt,
    emailSent: false,
    emailQueued: false,
    emailDeliveryAvailable: false,
    presentationCreated: true,
  };
});
