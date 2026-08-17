import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import {
  ACTIVITY_EVENT,
  ACTIVITY_SEVERITY,
  AUDIT_EVENT,
  INVITE_STATUS,
  ROLE_PERMISSIONS,
  SESSION_STATUS,
  isTimeLimitedPolicy,
  type SessionStatus,
} from "../shared";
import { writeAnalyticsEvent, writeAuditEvent } from "../lib/audit";
import { writePresentationActivity } from "../lib/presentationActivity";
import { logUnexpectedException } from "../lib/diagnostics";
import { hashToken } from "../lib/crypto";
import { auth, db } from "../lib/firebase";
import {
  genericAccessUnavailableMessage,
  sessionIsExpired,
  sessionSingleViewBlocked,
} from "../lib/presentationPolicy";
import { clientIpFromRequest, parseUserAgent } from "../lib/ua";

interface ExchangeRequest {
  token: string;
  deviceId: string;
}

/**
 * Opening an invitation authenticates the client to the session.
 * It does NOT consume the one-time viewing and does NOT create a viewing lease.
 */
export const exchangeInviteToken = onCall(async (request) => {
  const data = request.data as ExchangeRequest;
  const token = (data.token || "").trim();
  const deviceId = (data.deviceId || "").trim();
  const ip = clientIpFromRequest(request.rawRequest?.headers["x-forwarded-for"]);
  const env = parseUserAgent(request.rawRequest?.headers["user-agent"] || "");

  if (!token || token.length < 20) {
    logger.warn("invite_exchange_failed", {
      reason: "invalid_token_format",
      tokenLength: token.length,
    });
    throw new HttpsError("invalid-argument", "Invalid invitation token.");
  }
  if (!deviceId || deviceId.length < 8) {
    logger.warn("invite_exchange_failed", { reason: "device_id_missing" });
    throw new HttpsError("invalid-argument", "deviceId required.");
  }

  const tokenHash = hashToken(token);
  const inviteQuery = await db
    .collection("invites")
    .where("tokenHash", "==", tokenHash)
    .limit(1)
    .get();

  if (inviteQuery.empty) {
    logger.warn("invite_exchange_failed", {
      reason: "invitation_document_missing",
      collection: "invites",
      field: "tokenHash",
      tokenHashPrefix: tokenHash.slice(0, 8),
    });
    await writeAuditEvent({
      type: AUDIT_EVENT.FAILED_ACCESS_ATTEMPT,
      actorType: "client",
      ipAddress: ip,
      payload: { reason: "unknown_token", ...env } as Record<string, unknown>,
    });
    throw new HttpsError("not-found", "Invitation not found.");
  }

  const inviteDoc = inviteQuery.docs[0]!;
  const invite = inviteDoc.data();
  const sessionId = invite.sessionId as string;
  const sessionRef = db.collection("presentationSessions").doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) {
    logger.warn("invite_exchange_failed", {
      reason: "presentation_missing",
      inviteId: inviteDoc.id,
      sessionId,
    });
    throw new HttpsError("failed-precondition", "Session missing.");
  }
  const session = sessionSnap.data()!;
  const status = session.status as SessionStatus;

  if (sessionSingleViewBlocked(session)) {
    logger.info("invite_exchange_failed", {
      reason: "already_viewed",
      inviteId: inviteDoc.id,
      sessionId,
      sessionStatus: status,
      inviteStatus: invite.status,
    });
    await writeAuditEvent({
      type: AUDIT_EVENT.FAILED_ACCESS_ATTEMPT,
      sessionId,
      inviteId: inviteDoc.id,
      representativeId: session.representativeId,
      actorType: "client",
      ipAddress: ip,
      payload: { reason: "already_viewed", ...env } as Record<string, unknown>,
    });
    await writePresentationActivity({
      sessionId,
      inviteId: inviteDoc.id,
      companyId: (session.companyId as string) || null,
      representativeId: (session.representativeId as string) || null,
      type: ACTIVITY_EVENT.ACCESS_DENIED,
      severity: ACTIVITY_SEVERITY.ERROR,
      description: "Access denied — viewing entitlement already consumed.",
      errorCode: "viewing_entitlement_consumed",
      env,
      ipAddress: ip,
      actorType: "client",
    });
    throw new HttpsError(
      "failed-precondition",
      genericAccessUnavailableMessage(),
    );
  }

  if (status === SESSION_STATUS.REVOKED || invite.status === INVITE_STATUS.REVOKED) {
    logger.info("invite_exchange_failed", {
      reason: "revoked",
      inviteId: inviteDoc.id,
      sessionId,
    });
    await writeAuditEvent({
      type: AUDIT_EVENT.FAILED_ACCESS_ATTEMPT,
      sessionId,
      inviteId: inviteDoc.id,
      actorType: "client",
      ipAddress: ip,
      payload: { reason: "revoked" },
    });
    await writePresentationActivity({
      sessionId,
      inviteId: inviteDoc.id,
      companyId: (session.companyId as string) || null,
      representativeId: (session.representativeId as string) || null,
      type: ACTIVITY_EVENT.INVITATION_REVOKED,
      severity: ACTIVITY_SEVERITY.ERROR,
      description: "Client attempted to open a revoked invitation.",
      errorCode: "revoked",
      env,
      ipAddress: ip,
      actorType: "client",
    });
    throw new HttpsError("failed-precondition", "This invitation has been revoked.");
  }

  if (
    status === SESSION_STATUS.EXPIRED ||
    sessionIsExpired(session)
  ) {
    logger.info("invite_exchange_failed", {
      reason: "expired",
      inviteId: inviteDoc.id,
      sessionId,
      expiresAt: session.expiresAt,
      sessionStatus: status,
    });
    if (status !== SESSION_STATUS.EXPIRED) {
      await sessionRef.update({
        status: SESSION_STATUS.EXPIRED,
        updatedAt: new Date().toISOString(),
        updatedAtServer: FieldValue.serverTimestamp(),
      });
      await inviteDoc.ref.update({ status: INVITE_STATUS.EXPIRED });
    }
    await writePresentationActivity({
      sessionId,
      inviteId: inviteDoc.id,
      companyId: (session.companyId as string) || null,
      representativeId: (session.representativeId as string) || null,
      type: ACTIVITY_EVENT.INVITATION_EXPIRED,
      severity: ACTIVITY_SEVERITY.WARNING,
      description: "Client attempted to open an expired invitation.",
      errorCode: "expired",
      env,
      ipAddress: ip,
      actorType: "client",
    });
    throw new HttpsError("failed-precondition", genericAccessUnavailableMessage());
  }

  const leaseSnap = await db.collection("viewingLeases").doc(sessionId).get();
  if (leaseSnap.exists) {
    const lease = leaseSnap.data()!;
    const leaseActive =
      lease.status === "active" &&
      new Date(String(lease.leaseExpiresAt)).getTime() > Date.now();
    if (leaseActive && lease.deviceId && lease.deviceId !== deviceId) {
      await writeAuditEvent({
        type: AUDIT_EVENT.FAILED_ACCESS_ATTEMPT,
        sessionId,
        inviteId: inviteDoc.id,
        representativeId: session.representativeId,
        actorType: "client",
        ipAddress: ip,
        payload: { reason: "active_lease_other_device", ...env } as Record<
          string,
          unknown
        >,
      });
      throw new HttpsError(
        "failed-precondition",
        "This presentation is already being viewed on another device.",
      );
    }
  }

  const clientUid = `client_${sessionId}`;
  try {
    const existing = await auth.getUser(clientUid);
    if (existing.disabled && !isTimeLimitedPolicy(session.accessPolicy)) {
      throw new HttpsError(
        "failed-precondition",
        genericAccessUnavailableMessage(),
      );
    }
    if (existing.disabled && isTimeLimitedPolicy(session.accessPolicy)) {
      await auth.updateUser(clientUid, { disabled: false });
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    await auth.createUser({
      uid: clientUid,
      displayName: session.clientName,
      disabled: false,
    });
  }

  await auth.setCustomUserClaims(clientUid, {
    rolePrimary: "client",
    roleIds: ["client"],
    permissions: [...ROLE_PERMISSIONS.client],
    sessionId,
    inviteId: inviteDoc.id,
    ver: Date.now(),
  });

  // Sign the client custom token BEFORE marking invitation opened.
  // Root-cause class: requires iam.serviceAccounts.signBlob on the Functions SA.
  let customToken: string;
  try {
    customToken = await auth.createCustomToken(clientUid, {
      rolePrimary: "client",
      sessionId,
      inviteId: inviteDoc.id,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("invite_exchange_failed", {
      reason: "custom_token_sign_failed",
      inviteId: inviteDoc.id,
      sessionId,
      clientUid,
      detail,
    });
    await logUnexpectedException({
      err,
      sessionId,
      inviteId: inviteDoc.id,
      companyId: (session.companyId as string) || null,
      representativeId: (session.representativeId as string) || null,
      cloudFunction: "exchangeInviteToken",
      errorCode: "SIGNING_CONFIG",
      env,
      ipAddress: ip,
      actorType: "system",
    });
    throw new HttpsError(
      "failed-precondition",
      "We're sorry, but there was a problem loading your presentation. Please contact your representative for assistance.",
    );
  }

  const openedAt = new Date().toISOString();
  const updates: Record<string, unknown> = {
    updatedAt: openedAt,
    updatedAtServer: FieldValue.serverTimestamp(),
  };
  const reopening =
    isTimeLimitedPolicy(session.accessPolicy) &&
    (status === SESSION_STATUS.COMPLETED || status === SESSION_STATUS.CLOSED);
  if (reopening) {
    updates.status = SESSION_STATUS.LEGAL_ACCEPTED;
    await writePresentationActivity({
      sessionId,
      inviteId: inviteDoc.id,
      companyId: (session.companyId as string) || null,
      representativeId: (session.representativeId as string) || null,
      type: ACTIVITY_EVENT.PRESENTATION_REOPENED,
      severity: ACTIVITY_SEVERITY.INFO,
      description: "Client reopened a time-limited presentation during the availability window.",
      env,
      ipAddress: ip,
      actorType: "client",
      actorUid: clientUid,
    });
  }
  if (status === SESSION_STATUS.PENDING) {
    updates.status = SESSION_STATUS.OPENED;
    updates["analytics.invitationOpenedAt"] = openedAt;
    await inviteDoc.ref.update({
      status: INVITE_STATUS.OPENED,
      openedAt,
    });
    await writeAuditEvent({
      type: AUDIT_EVENT.INVITATION_OPENED,
      sessionId,
      inviteId: inviteDoc.id,
      representativeId: session.representativeId,
      actorUid: clientUid,
      actorType: "client",
      ipAddress: ip,
      payload: { ...env, deviceId } as Record<string, unknown>,
    });
    await writeAnalyticsEvent({
      sessionId,
      representativeId: session.representativeId,
      metric: "invitation_opened",
      value: openedAt,
      videoVersionId: session.videoId,
    });
    await writePresentationActivity({
      sessionId,
      inviteId: inviteDoc.id,
      companyId: (session.companyId as string) || null,
      representativeId: (session.representativeId as string) || null,
      type: ACTIVITY_EVENT.INVITATION_OPENED,
      severity: ACTIVITY_SEVERITY.SUCCESS,
      description: "Client opened the secure invitation link.",
      env,
      ipAddress: ip,
      actorType: "client",
      actorUid: clientUid,
      payload: { deviceId },
    });
  }
  await sessionRef.update(updates);

  await writePresentationActivity({
    sessionId,
    inviteId: inviteDoc.id,
    companyId: (session.companyId as string) || null,
    representativeId: (session.representativeId as string) || null,
    type: ACTIVITY_EVENT.DEVICE_CAPTURED,
    severity: ACTIVITY_SEVERITY.INFO,
    title: "Device",
    description: `${env.deviceType} · ${env.browser} · ${env.operatingSystem}`,
    env,
    ipAddress: ip,
    actorType: "client",
    actorUid: clientUid,
    payload: { deviceId },
  });

  let companyName = String(session.companyName || "").trim();
  let videoTitle = "Presentation";
  let estimatedDurationLabel = "Approximately 10–15 minutes";
  let legalDocuments: Array<{
    type: string;
    title: string;
    versionLabel: string;
  }> = [];

  try {
    const companyId = String(session.companyId || "");
    if (companyId) {
      const companySnap = await db.collection("companies").doc(companyId).get();
      if (companySnap.exists) {
        const company = companySnap.data()!;
        companyName =
          String(company.displayEmailName || company.name || "").trim() ||
          companyName ||
          "Presentation Hub";
      }
    }
    if (!companyName) companyName = "Presentation Hub";

    const videoId = String(session.videoId || "");
    if (videoId) {
      const videoSnap = await db.collection("videos").doc(videoId).get();
      if (videoSnap.exists) {
        const video = videoSnap.data()!;
        videoTitle =
          String(video.title || "Presentation").trim() || "Presentation";
        const durationSeconds =
          typeof video.durationSeconds === "number"
            ? video.durationSeconds
            : null;
        if (durationSeconds && durationSeconds > 0) {
          const mins = Math.max(1, Math.round(durationSeconds / 60));
          estimatedDurationLabel =
            mins === 1 ? "About 1 minute" : `About ${mins} minutes`;
        }
      }
    }

    const { getActiveLegalDocsForCompany, getActiveLegalDocs } = await import(
      "../lib/settings"
    );
    const { docs } = companyId
      ? await getActiveLegalDocsForCompany(companyId)
      : await getActiveLegalDocs();
    legalDocuments = docs.map((d) => ({
      type: d.type,
      title: d.title,
      versionLabel: d.versionLabel,
    }));
  } catch (err) {
    if (err instanceof HttpsError) {
      logger.warn("invite_exchange_failed", {
        reason: "welcome_payload_content",
        inviteId: inviteDoc.id,
        sessionId,
        detail: err.message,
      });
      throw err;
    }
    logger.error("invite_exchange_failed", {
      reason: "welcome_payload_unexpected",
      inviteId: inviteDoc.id,
      sessionId,
      detail: err instanceof Error ? err.message : String(err),
    });
    await logUnexpectedException({
      err,
      sessionId,
      inviteId: inviteDoc.id,
      companyId: (session.companyId as string) || null,
      representativeId: (session.representativeId as string) || null,
      cloudFunction: "exchangeInviteToken",
      errorCode: "WELCOME_PAYLOAD",
      env,
      ipAddress: ip,
      actorType: "system",
    });
    throw new HttpsError(
      "failed-precondition",
      "We're sorry, but there was a problem loading your presentation. Please contact your representative for assistance.",
    );
  }

  if (!session.companyName && companyName) {
    await sessionRef.update({
      companyName,
      updatedAt: new Date().toISOString(),
      updatedAtServer: FieldValue.serverTimestamp(),
    });
  }

  logger.info("invite_exchange_ok", {
    inviteId: inviteDoc.id,
    sessionId,
    clientName: session.clientName,
  });

  return {
    customToken,
    sessionId,
    status: (updates.status as string) || status,
    clientName: session.clientName,
    companyName,
    representativeName: session.representativeName,
    videoTitle,
    estimatedDurationLabel,
    legalDocuments,
    alreadyViewed: false,
    viewingConsumed: false,
  };
});
