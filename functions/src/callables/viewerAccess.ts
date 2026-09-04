import { FieldValue } from "firebase-admin/firestore";
import { onRequest, HttpsError } from "firebase-functions/v2/https";
import { onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { randomBytes } from "node:crypto";
import {
  ACTIVITY_EVENT,
  ACTIVITY_SEVERITY,
  AUDIT_EVENT,
  INVITE_STATUS,
  VIEWER_SESSION_COOKIE,
  VIEWER_SESSION_TTL_MS,
  SESSION_STATUS,
  PERMISSIONS,
  type SessionStatus,
} from "../shared";
import { loadStaffContext } from "../lib/authz";
import { writeAuditEvent } from "../lib/audit";
import { writePresentationActivity } from "../lib/presentationActivity";
import { hashToken } from "../lib/crypto";
import { auth, db } from "../lib/firebase";
import { clientIpFromRequest, parseUserAgent } from "../lib/ua";
import {
  genericAccessUnavailableMessage,
  sessionIsExpired,
  sessionSingleViewBlocked,
} from "../lib/presentationPolicy";
import { clearInterruptedLease } from "../lib/viewingLease";
import {
  VIEWER_DEVICE_BLOCKED_MESSAGE,
  resolveViewerDeviceClaim,
} from "../lib/viewerDeviceClaim.pure";

/** Opaque viewer session id stored in HttpOnly cookie + Firestore. */
function generateViewerSessionId(): string {
  return randomBytes(32).toString("hex");
}

/** Parse JSON body safely */
function parseBody(req: { body?: unknown }): Record<string, unknown> {
  if (typeof req.body === "object" && req.body !== null) {
    return req.body as Record<string, unknown>;
  }
  return {};
}

/** Set HttpOnly Secure cookie */
function setViewerCookie(
  res: { setHeader: (name: string, value: string) => void },
  sessionId: string,
): void {
  const maxAge = Math.floor(VIEWER_SESSION_TTL_MS / 1000);
  const cookie = `${VIEWER_SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}; Path=/`;
  res.setHeader("Set-Cookie", cookie);
}

/** Parse viewer cookie */
function parseViewerCookie(req: { headers?: { cookie?: string } }): string | null {
  const cookieHeader = req.headers?.cookie || "";
  const match = cookieHeader.match(new RegExp(`${VIEWER_SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

type EnvInfo = ReturnType<typeof parseUserAgent>;

/**
 * Viewer Access HTTP endpoint (invitation-link possession + device binding).
 * Routes: /api/viewer/resume, /api/viewer/claim
 * Deprecated (410): begin, send-otp, verify-otp
 */
export const viewerAccessHttp = onRequest(
  { cors: false, invoker: "public" },
  async (req, res) => {
    const path = req.path.replace(/^\/api\/viewer\/?/, "").split("/")[0] || "";
    const body = parseBody(req);
    const ip = clientIpFromRequest(req.headers["x-forwarded-for"]);
    const env = parseUserAgent(req.headers["user-agent"] || "");

    try {
      switch (path) {
        case "resume":
          await handleResume(req, res, body, ip, env);
          break;
        case "claim":
          await handleClaim(req, res, body, ip, env);
          break;
        case "begin":
        case "send-otp":
        case "verify-otp":
          res.status(410).json({
            error:
              "Email verification codes are no longer used. Reopen your invitation link to continue.",
            deprecated: true,
          });
          break;
        default:
          res.status(404).json({ error: "Not found" });
      }
    } catch (err) {
      logger.error("viewer_access_error", { path, error: String(err) });
      const message =
        err instanceof HttpsError
          ? err.message
          : "An error occurred. Please try again.";
      res.status(err instanceof HttpsError ? 400 : 500).json({ error: message });
    }
  },
);

async function loadSessionForViewer(token: string): Promise<{
  session: FirebaseFirestore.DocumentData;
  sessionId: string;
  sessionRef: FirebaseFirestore.DocumentReference;
  inviteDoc: FirebaseFirestore.QueryDocumentSnapshot;
  invite: FirebaseFirestore.DocumentData;
}> {
  if (!token || token.length < 20) {
    throw new HttpsError("invalid-argument", "Invalid invitation token.");
  }

  const tokenHash = hashToken(token);
  const inviteQuery = await db
    .collection("invites")
    .where("tokenHash", "==", tokenHash)
    .limit(1)
    .get();

  if (inviteQuery.empty) {
    throw new HttpsError("not-found", "Invitation not found.");
  }

  const inviteDoc = inviteQuery.docs[0]!;
  const invite = inviteDoc.data();
  const sessionId = invite.sessionId as string;
  const sessionRef = db.collection("presentationSessions").doc(sessionId);
  const sessionSnap = await sessionRef.get();

  if (!sessionSnap.exists) {
    throw new HttpsError("failed-precondition", "Session not found.");
  }

  const session = sessionSnap.data()!;
  const status = session.status as SessionStatus;

  if (
    status === SESSION_STATUS.REVOKED ||
    invite.status === INVITE_STATUS.REVOKED
  ) {
    throw new HttpsError("failed-precondition", "This invitation has been revoked.");
  }

  if (
    status === SESSION_STATUS.EXPIRED ||
    invite.status === INVITE_STATUS.EXPIRED ||
    sessionIsExpired(session)
  ) {
    throw new HttpsError("failed-precondition", genericAccessUnavailableMessage());
  }

  if (sessionSingleViewBlocked(session)) {
    throw new HttpsError("failed-precondition", genericAccessUnavailableMessage());
  }

  return { session, sessionId, sessionRef, inviteDoc, invite };
}

async function mintClientCustomToken(
  sessionId: string,
  inviteId: string,
  displayName: string,
): Promise<{ clientUid: string; customToken: string }> {
  const clientUid = `client_${sessionId}`;
  try {
    await auth.getUser(clientUid);
    await auth.updateUser(clientUid, { disabled: false });
  } catch {
    await auth.createUser({
      uid: clientUid,
      displayName,
      disabled: false,
    });
  }

  await auth.setCustomUserClaims(clientUid, {
    rolePrimary: "client",
    roleIds: ["client"],
    sessionId,
    inviteId,
    viewerVerified: true,
    ver: Date.now(),
  });

  const customToken = await auth.createCustomToken(clientUid, {
    rolePrimary: "client",
    sessionId,
    inviteId,
    viewerVerified: true,
  });

  return { clientUid, customToken };
}

/**
 * Atomic first-device claim using the invitation link as possession credential.
 * Only one concurrent claim can win the transaction.
 */
async function handleClaim(
  req: { headers?: { cookie?: string } },
  res: {
    json: (data: unknown) => void;
    setHeader: (name: string, value: string) => void;
  },
  body: Record<string, unknown>,
  ip: string,
  env: EnvInfo,
): Promise<void> {
  const token = String(body.token || "").trim();
  const { session, sessionId, sessionRef, inviteDoc, invite } =
    await loadSessionForViewer(token);
  const viewerCookie = parseViewerCookie(req);
  const nowIso = new Date().toISOString();
  const candidateSessionId = generateViewerSessionId();

  const txResult = await db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(sessionRef);
    if (!freshSnap.exists) {
      throw new HttpsError("failed-precondition", "Session not found.");
    }
    const fresh = freshSnap.data()!;
    if (sessionSingleViewBlocked(fresh) || sessionIsExpired(fresh)) {
      throw new HttpsError("failed-precondition", genericAccessUnavailableMessage());
    }

    const existing = fresh.viewerAuth?.authorizedSessionId as string | undefined;
    const decision = resolveViewerDeviceClaim({
      existingAuthorizedSessionId: existing,
      requestCookie: viewerCookie,
    });

    if (decision === "blocked") {
      return { kind: "blocked" as const, authorizedSessionId: existing! };
    }

    if (decision === "same_device") {
      return {
        kind: "same_device" as const,
        authorizedSessionId: existing!,
        firstOpen: false,
      };
    }

    // First claim wins.
    const status = fresh.status as SessionStatus;
    const updates: Record<string, unknown> = {
      "viewerAuth.authorizedSessionId": candidateSessionId,
      "viewerAuth.authorizedAt": nowIso,
      "viewerAuth.emailVerifiedAt": nowIso, // legacy field: marks authorization complete
      "viewerAuth.otpHash": null,
      "viewerAuth.otpExpiresAt": null,
      "viewerAuth.otpAttempts": 0,
      lastMeaningfulClientActivityAt: nowIso,
      updatedAt: nowIso,
      updatedAtServer: FieldValue.serverTimestamp(),
    };

    if (status === SESSION_STATUS.PENDING) {
      updates.status = SESSION_STATUS.OPENED;
      updates["analytics.invitationOpenedAt"] = nowIso;
    }

    tx.update(sessionRef, updates);

    if (
      invite.status === INVITE_STATUS.PENDING ||
      invite.status === INVITE_STATUS.SENT
    ) {
      tx.update(inviteDoc.ref, {
        status: INVITE_STATUS.OPENED,
        updatedAt: nowIso,
        updatedAtServer: FieldValue.serverTimestamp(),
      });
    }

    return {
      kind: "claimed" as const,
      authorizedSessionId: candidateSessionId,
      firstOpen: status === SESSION_STATUS.PENDING,
    };
  });

  if (txResult.kind === "blocked") {
    await writePresentationActivity({
      sessionId,
      inviteId: inviteDoc.id,
      companyId: (session.companyId as string) || null,
      representativeId: (session.representativeId as string) || null,
      type: ACTIVITY_EVENT.NEW_DEVICE_BLOCKED,
      severity: ACTIVITY_SEVERITY.WARNING,
      description: "Invitation opened on a different device was blocked.",
      env,
      ipAddress: ip,
      actorType: "client",
    });

    res.json({
      ok: false,
      deviceBlocked: true,
      error: VIEWER_DEVICE_BLOCKED_MESSAGE,
    });
    return;
  }

  const { clientUid, customToken } = await mintClientCustomToken(
    sessionId,
    inviteDoc.id,
    String(session.clientName || "Guest"),
  );

  setViewerCookie(res, txResult.authorizedSessionId);

  if (txResult.kind === "claimed") {
    if (txResult.firstOpen) {
      await writeAuditEvent({
        type: AUDIT_EVENT.INVITATION_OPENED,
        sessionId,
        inviteId: inviteDoc.id,
        representativeId: session.representativeId as string,
        actorType: "client",
        actorUid: clientUid,
        ipAddress: ip,
        payload: { via: "invitation_link_claim" },
      });
      await writePresentationActivity({
        sessionId,
        inviteId: inviteDoc.id,
        companyId: (session.companyId as string) || null,
        representativeId: (session.representativeId as string) || null,
        type: ACTIVITY_EVENT.INVITATION_OPENED,
        severity: ACTIVITY_SEVERITY.INFO,
        description: "Invitation opened and bound to this browser.",
        env,
        ipAddress: ip,
        actorType: "client",
        actorUid: clientUid,
      });
    }

    await writePresentationActivity({
      sessionId,
      inviteId: inviteDoc.id,
      companyId: (session.companyId as string) || null,
      representativeId: (session.representativeId as string) || null,
      type: ACTIVITY_EVENT.DEVICE_AUTHORIZED,
      severity: ACTIVITY_SEVERITY.SUCCESS,
      description: "Browser authorized via invitation link (no email code).",
      env,
      ipAddress: ip,
      actorType: "client",
      actorUid: clientUid,
    });
  }

  logger.info("viewer_device_claimed", {
    sessionId,
    kind: txResult.kind,
    firstOpen: txResult.kind === "claimed" ? txResult.firstOpen : false,
  });

  res.json({
    ok: true,
    customToken,
    sessionId,
    clientName: session.clientName,
    companyName: session.companyName || "Presentation Hub",
    alreadyVerified: true,
  });
}

/** Resume: cookie must match authorizedSessionId. */
async function handleResume(
  req: { headers?: { cookie?: string } },
  res: { json: (data: unknown) => void },
  body: Record<string, unknown>,
  ip: string,
  env: EnvInfo,
): Promise<void> {
  const token = String(body.token || "").trim();
  const { session, sessionId, inviteDoc } = await loadSessionForViewer(token);

  const viewerAuth = session.viewerAuth || {};
  const authorizedSessionId = viewerAuth.authorizedSessionId as string | undefined;
  const viewerCookie = parseViewerCookie(req);
  const decision = resolveViewerDeviceClaim({
    existingAuthorizedSessionId: authorizedSessionId,
    requestCookie: viewerCookie,
  });

  if (decision === "blocked") {
    await writePresentationActivity({
      sessionId,
      inviteId: inviteDoc.id,
      companyId: (session.companyId as string) || null,
      representativeId: (session.representativeId as string) || null,
      type: ACTIVITY_EVENT.NEW_DEVICE_BLOCKED,
      severity: ACTIVITY_SEVERITY.WARNING,
      description: "Resume attempt from a different device was blocked.",
      env,
      ipAddress: ip,
      actorType: "client",
    });
    res.json({
      ok: false,
      deviceBlocked: true,
      error: VIEWER_DEVICE_BLOCKED_MESSAGE,
    });
    return;
  }

  if (decision === "claim") {
    // Not yet bound — client should call /claim
    res.json({
      ok: false,
      needsClaim: true,
    });
    return;
  }

  const { customToken } = await mintClientCustomToken(
    sessionId,
    inviteDoc.id,
    String(session.clientName || "Guest"),
  );

  // Same authorized browser returning — count as meaningful client activity.
  const resumeNow = new Date().toISOString();
  await db
    .collection("presentationSessions")
    .doc(sessionId)
    .set(
      {
        lastMeaningfulClientActivityAt: resumeNow,
        updatedAt: resumeNow,
        updatedAtServer: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
    .catch(() => undefined);

  logger.info("viewer_session_resumed", { sessionId });

  res.json({
    ok: true,
    customToken,
    sessionId,
    clientName: session.clientName,
    companyName: session.companyName || "Presentation Hub",
    alreadyVerified: true,
  });
}

/**
 * Reset authorized device (staff only).
 * Clears the viewerAuth binding so the recipient can access from a new device.
 * Does NOT restart expiresAt or restore viewingEntitlementConsumed.
 */
export const resetAuthorizedDevice = onCall(async (request) => {
  const sessionId = String(request.data?.sessionId || "").trim();
  if (!sessionId) {
    throw new HttpsError("invalid-argument", "sessionId required.");
  }

  const ctx = await loadStaffContext(request);

  const canResetOwn = ctx.permissions.includes(PERMISSIONS.SESSIONS_RESET_OWN as never);
  const canResetCompany = ctx.permissions.includes(PERMISSIONS.SESSIONS_RESET_COMPANY as never);

  const sessionRef = db.collection("presentationSessions").doc(sessionId);
  const sessionSnap = await sessionRef.get();

  if (!sessionSnap.exists) {
    throw new HttpsError("not-found", "Session not found.");
  }

  const session = sessionSnap.data()!;

  if (!ctx.isPlatformAdmin) {
    if (canResetCompany) {
      if (session.companyId !== ctx.companyId) {
        throw new HttpsError("permission-denied", "Cross-company access denied.");
      }
    } else if (canResetOwn) {
      if (session.representativeId !== ctx.uid) {
        throw new HttpsError("permission-denied", "You can only reset your own sessions.");
      }
    } else {
      throw new HttpsError("permission-denied", "Missing permission to reset device.");
    }
  }

  const nowIso = new Date().toISOString();
  const deviceResetCount = ((session.viewerAuth?.deviceResetCount as number) || 0) + 1;

  // Device reset only clears browser-session binding. It MUST NOT alter:
  // expiresAt, accessPolicy, accessDurationDays, policyAppliedAt, or
  // viewingEntitlementConsumed (those require a separate explicit owner action).
  await sessionRef.update({
    "viewerAuth.authorizedSessionId": null,
    "viewerAuth.authorizedAt": null,
    "viewerAuth.emailVerifiedAt": null,
    "viewerAuth.otpHash": null,
    "viewerAuth.otpExpiresAt": null,
    "viewerAuth.otpAttempts": 0,
    "viewerAuth.deviceResetCount": deviceResetCount,
    "viewerAuth.lastDeviceResetAt": nowIso,
    "viewerAuth.lastDeviceResetBy": ctx.uid,
    viewingDeviceId: FieldValue.delete(),
    updatedAt: nowIso,
    updatedAtServer: FieldValue.serverTimestamp(),
  });

  await clearInterruptedLease(sessionId).catch(() => undefined);

  const ip = clientIpFromRequest(request.rawRequest?.headers["x-forwarded-for"]);
  const env = parseUserAgent(request.rawRequest?.headers["user-agent"] || "");

  await writeAuditEvent({
    type: AUDIT_EVENT.SESSION_RESET as never,
    sessionId,
    inviteId: session.inviteId,
    representativeId: session.representativeId,
    actorUid: ctx.uid,
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    ipAddress: ip,
    payload: { reason: "device_reset", deviceResetCount },
  });

  await writePresentationActivity({
    sessionId,
    inviteId: session.inviteId,
    companyId: (session.companyId as string) || null,
    representativeId: (session.representativeId as string) || null,
    type: ACTIVITY_EVENT.DEVICE_RESET,
    severity: ACTIVITY_SEVERITY.INFO,
    description: `Authorized device reset by ${ctx.profile.displayName || ctx.uid}. Client can now open the invitation on a new device.`,
    env,
    ipAddress: ip,
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    actorUid: ctx.uid,
    payload: { deviceResetCount },
  });

  logger.info("viewer_device_reset", { sessionId, by: ctx.uid, count: deviceResetCount });

  return {
    ok: true,
    sessionId,
    message: "Authorized device has been reset. The client can now access from a new device.",
    deviceResetCount,
  };
});
