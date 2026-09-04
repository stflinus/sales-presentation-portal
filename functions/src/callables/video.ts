import {
  FieldValue,
  type DocumentData,
  type DocumentReference,
} from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  ACTIVITY_EVENT,
  ACTIVITY_SEVERITY,
  AUDIT_EVENT,
  CONTACT_STATUS,
  INVITE_STATUS,
  MEANINGFUL_PLAYBACK_SECONDS,
  SESSION_STATUS,
  SIGNED_URL_TTL_MS,
  VIDEO_COMPLETION_THRESHOLD,
  isTimeLimitedPolicy,
  type SessionStatus,
} from "../shared";
import { requireClientSession } from "../lib/authz";
import { writeAnalyticsEvent, writeAuditEvent } from "../lib/audit";
import { writePresentationActivity } from "../lib/presentationActivity";
import { sendCompletionEmail } from "../lib/email";
import { resolveAppOrigin } from "../lib/appOrigin";
import { auth, bucket, db } from "../lib/firebase";
import { clientIpFromRequest, parseUserAgent } from "../lib/ua";
import {
  acquireOrRenewLease,
  assertLeaseAllowsDevice,
  assertSessionAccessible,
  markLeaseConsumed,
  renewLease,
} from "../lib/viewingLease";
import {
  capSignedUrlExpiresAtMs,
  genericAccessUnavailableMessage,
  sessionIsExpired,
  shouldConsumeViewingEntitlementOnCompletion,
} from "../lib/presentationPolicy";

async function loadEligibleSession(sessionId: string, deviceId: string) {
  if (!deviceId || deviceId.length < 8) {
    throw new HttpsError("invalid-argument", "deviceId required.");
  }
  const sessionRef = db.collection("presentationSessions").doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) throw new HttpsError("not-found", "Session not found.");
  const session = sessionSnap.data()!;
  const status = session.status as SessionStatus;

  if (sessionIsExpired(session)) {
    throw new HttpsError("failed-precondition", genericAccessUnavailableMessage());
  }

  assertSessionAccessible(session);

  if (status === SESSION_STATUS.REVOKED || status === SESSION_STATUS.EXPIRED) {
    throw new HttpsError("failed-precondition", genericAccessUnavailableMessage());
  }

  const replayAllowed =
    isTimeLimitedPolicy(session.accessPolicy) &&
    (status === SESSION_STATUS.COMPLETED || status === SESSION_STATUS.CLOSED);

  if (
    !replayAllowed &&
    status !== SESSION_STATUS.LEGAL_ACCEPTED &&
    status !== SESSION_STATUS.IN_PROGRESS
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Legal acceptance required before video access.",
    );
  }

  if (!replayAllowed && !session.legalAcceptanceId) {
    throw new HttpsError("failed-precondition", "Legal acceptance record missing.");
  }

  const videoSnap = await db.collection("videos").doc(session.videoId).get();
  if (!videoSnap.exists) throw new HttpsError("failed-precondition", "Video missing.");
  const video = videoSnap.data()!;

  // Tombstone or permanently deleted — always deny
  if (video.tombstone === true || video.permanentlyDeletedAt) {
    throw new HttpsError(
      "failed-precondition",
      "This presentation is no longer available. Please contact your representative.",
    );
  }

  // Soft deleted — always deny
  if (video.deleted === true || video.status === "deleted") {
    throw new HttpsError(
      "failed-precondition",
      "This presentation is no longer available. Please contact your representative.",
    );
  }

  // Placeholder — always deny
  if (video.isPlaceholder === true) {
    throw new HttpsError(
      "failed-precondition",
      "This presentation is no longer available. Please contact your representative.",
    );
  }

  if (video.status === "draft") {
    throw new HttpsError(
      "failed-precondition",
      "This presentation is no longer available. Please contact your representative.",
    );
  }

  // Archived — allow only if allowExistingSessions=true AND this session's videoId matches
  if (video.status === "archived" || video.archived === true) {
    if (video.allowExistingSessions === true && session.videoId === videoSnap.id) {
      // Allow existing authorized sessions to continue
    } else {
      throw new HttpsError(
        "failed-precondition",
        "This presentation is no longer available. Please contact your representative.",
      );
    }
  }

  // Inactive — allow only if allowExistingSessions=true
  if (video.status === "inactive" || video.active === false) {
    if (video.allowExistingSessions !== true) {
      throw new HttpsError(
        "failed-precondition",
        "This presentation is no longer available. Please contact your representative.",
      );
    }
  }

  return { sessionRef, session, video, videoId: videoSnap.id, status };
}

/**
 * Mint a private Storage signed URL.
 * Never extends past the invitation/session snapshotted expiresAt.
 */
async function mintSignedUrl(
  storagePath: string,
  invitationExpiresAt?: string | null,
): Promise<{ url: string; expiresAt: string }> {
  const file = bucket.file(storagePath);
  const [exists] = await file.exists();
  if (!exists) {
    throw new HttpsError("failed-precondition", "Video file not found in storage.");
  }
  const nowMs = Date.now();
  const expiresAtMs = capSignedUrlExpiresAtMs({
    nowMs,
    signedUrlTtlMs: SIGNED_URL_TTL_MS,
    invitationExpiresAt,
  });
  if (expiresAtMs == null) {
    throw new HttpsError("failed-precondition", genericAccessUnavailableMessage());
  }
  const [url] = await file.getSignedUrl({
    action: "read",
    expires: expiresAtMs,
    version: "v4",
  });
  return { url, expiresAt: new Date(expiresAtMs).toISOString() };
}

/**
 * Prepare / renew signed URL.
 * Does NOT start the viewing lease and does NOT consume the one-time viewing.
 * Blocked if another device holds an active lease.
 */
export const grantVideoAccess = onCall(async (request) => {
  const sessionId = String(request.data?.sessionId || "");
  const deviceId = String(request.data?.deviceId || "");
  requireClientSession(request, sessionId);

  const { session, video, videoId } = await loadEligibleSession(sessionId, deviceId);
  await assertLeaseAllowsDevice(sessionId, deviceId, { requireActiveLease: false });

  // If a lease is already active for this device, renew it while minting.
  const leaseSnap = await db.collection("viewingLeases").doc(sessionId).get();
  if (leaseSnap.exists) {
    const lease = leaseSnap.data();
    if (lease?.status === "active" && lease.deviceId === deviceId) {
      await renewLease(sessionId, deviceId);
    }
  }

  // Use playbackStoragePath > optimizedStoragePath > storagePath (Bill 20-min fix)
  const playbackPath =
    (video.playbackStoragePath as string) ||
    (video.optimizedStoragePath as string) ||
    (video.storagePath as string);

  const { url, expiresAt } = await mintSignedUrl(
    playbackPath,
    String(session.expiresAt || "") || null,
  );
  const expiresInSeconds = Math.max(
    0,
    Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000),
  );

  // Extract slide markers from video document
  const slideMarkers = video.slideMarkers || null;

  const ip = clientIpFromRequest(request.rawRequest?.headers["x-forwarded-for"]);
  const env = parseUserAgent(request.rawRequest?.headers["user-agent"] || "");
  await writePresentationActivity({
    sessionId,
    inviteId: session.inviteId || null,
    companyId: (session.companyId as string) || null,
    representativeId: (session.representativeId as string) || null,
    type: ACTIVITY_EVENT.PLAYBACK_AUTHORIZED,
    severity: ACTIVITY_SEVERITY.INFO,
    description: "Signed playback URL authorized for the bound device.",
    env,
    ipAddress: ip,
    actorType: "client",
    actorUid: request.auth?.uid || null,
    payload: { videoId, expiresAt },
  }).catch(() => undefined);

  const nowIso = new Date().toISOString();
  await db
    .collection("presentationSessions")
    .doc(sessionId)
    .set(
      {
        lastMeaningfulClientActivityAt: nowIso,
        updatedAt: nowIso,
        updatedAtServer: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
    .catch(() => undefined);

  return {
    videoUrl: url,
    expiresAt,
    expiresInSeconds,
    invitationExpiresAt: session.expiresAt || null,
    title: video.title,
    durationSeconds: video.durationSeconds ?? null,
    videoId,
    slideMarkers,
    leaseRequiredForPlayback: true,
    controls: {
      download: false,
      pictureInPicture: true,
      remotePlayback: true,
      playbackRate: true,
      nativeControls: false,
    },
    note: "Signed URL TTL is capped by invitation expiration. Viewing lease begins only after meaningful playback.",
  };
});

/**
 * Called when meaningful playback begins (client play + progress threshold).
 * This is when the viewing becomes ACTIVE (lease), not when it is permanently consumed.
 */
export const acquireViewingLease = onCall(async (request) => {
  const sessionId = String(request.data?.sessionId || "");
  const deviceId = String(request.data?.deviceId || "");
  const currentTime = Number(request.data?.currentTime ?? 0);
  const uid = requireClientSession(request, sessionId);
  const ip = clientIpFromRequest(request.rawRequest?.headers["x-forwarded-for"]);
  const env = parseUserAgent(request.rawRequest?.headers["user-agent"] || "");

  if (!Number.isFinite(currentTime) || currentTime < 0) {
    throw new HttpsError("invalid-argument", "Invalid currentTime.");
  }
  if (currentTime < MEANINGFUL_PLAYBACK_SECONDS) {
    throw new HttpsError(
      "failed-precondition",
      "Meaningful playback has not begun yet.",
    );
  }

  const { sessionRef, session, videoId } = await loadEligibleSession(
    sessionId,
    deviceId,
  );

  const { lease, created } = await acquireOrRenewLease({
    sessionId,
    deviceId,
    userAgent: env.userAgent,
    ipAddress: ip,
  });

  const nowIso = new Date().toISOString();
  const updates: Record<string, unknown> = {
    status: SESSION_STATUS.IN_PROGRESS,
    viewingDeviceId: deviceId,
    updatedAt: nowIso,
    updatedAtServer: FieldValue.serverTimestamp(),
    maxWatchedSeconds: Math.max(Number(session.maxWatchedSeconds || 0), currentTime),
    lastMeaningfulClientActivityAt: nowIso,
  };

  if (created) {
    const openedAt = session.analytics?.invitationOpenedAt as string | undefined;
    if (openedAt && session.analytics?.timeUntilVideoStartMs == null) {
      const timeUntilVideoStartMs = Date.now() - new Date(openedAt).getTime();
      updates["analytics.timeUntilVideoStartMs"] = timeUntilVideoStartMs;
      await writeAnalyticsEvent({
        sessionId,
        representativeId: session.representativeId,
        metric: "time_until_video_start_ms",
        value: timeUntilVideoStartMs,
        videoVersionId: videoId,
      });
    }
    await writeAuditEvent({
      type: AUDIT_EVENT.VIDEO_STARTED,
      sessionId,
      inviteId: session.inviteId,
      representativeId: session.representativeId,
      actorUid: uid,
      actorType: "client",
      ipAddress: ip,
      payload: { videoId, deviceId, leaseAcquiredAt: lease.acquiredAt },
    });
    await writePresentationActivity({
      sessionId,
      inviteId: session.inviteId,
      companyId: (session.companyId as string) || null,
      representativeId: session.representativeId,
      type: ACTIVITY_EVENT.VIDEO_STARTED,
      severity: ACTIVITY_SEVERITY.SUCCESS,
      description: "Video playback started after a meaningful watch threshold.",
      env,
      ipAddress: ip,
      actorType: "client",
      actorUid: uid,
      payload: { videoId, deviceId },
    });
    if (session.contactId) {
      try {
        await db.collection("contacts").doc(String(session.contactId)).update({
          status: CONTACT_STATUS.PRESENTATION_STARTED,
          lastSessionId: sessionId,
          updatedAt: nowIso,
          updatedAtServer: FieldValue.serverTimestamp(),
        });
      } catch {
        // non-fatal
      }
    }
  }

  await sessionRef.update(updates);
  // Do not mint a replacement signed URL here. The client already has a URL from
  // grantVideoAccess; replacing <video src> mid-playback forces a full media reload.
  return {
    ok: true,
    leaseExpiresAt: lease.leaseExpiresAt,
    leaseTtlSeconds: Math.floor(
      (new Date(lease.leaseExpiresAt).getTime() - Date.now()) / 1000,
    ),
    invitationExpiresAt: session.expiresAt || null,
  };
});

export const heartbeatPlayback = onCall(async (request) => {
    const sessionId = String(request.data?.sessionId || "");
    const deviceId = String(request.data?.deviceId || "");
    const currentTime = Number(request.data?.currentTime ?? 0);
    const duration = Number(request.data?.duration ?? 0);
    const uid = requireClientSession(request, sessionId);
    const ip = clientIpFromRequest(request.rawRequest?.headers["x-forwarded-for"]);

    if (!Number.isFinite(currentTime) || currentTime < 0) {
      throw new HttpsError("invalid-argument", "Invalid currentTime.");
    }

    const { sessionRef, session, videoId } = await loadEligibleSession(
      sessionId,
      deviceId,
    );

    // Heartbeat requires / renews an active lease for this device.
    if (currentTime >= MEANINGFUL_PLAYBACK_SECONDS) {
      await renewLease(sessionId, deviceId);
    } else {
      await assertLeaseAllowsDevice(sessionId, deviceId, { requireActiveLease: true });
    }

    const maxWatchedSeconds = Math.max(
      Number(session.maxWatchedSeconds || 0),
      currentTime,
    );
    // Rewinding is allowed: maxWatchedSeconds only increases; currentTime may decrease.
    const completionPercent =
      duration > 0 ? Math.min(100, (maxWatchedSeconds / duration) * 100) : 0;

    const nowIso = new Date().toISOString();
    await sessionRef.update({
      status: SESSION_STATUS.IN_PROGRESS,
      viewingDeviceId: deviceId,
      maxWatchedSeconds,
      completionPercent,
      "analytics.watchDurationMs": Math.round(maxWatchedSeconds * 1000),
      "analytics.completionPercent": completionPercent,
      lastMeaningfulClientActivityAt: nowIso,
      updatedAt: nowIso,
      updatedAtServer: FieldValue.serverTimestamp(),
    });

    const prev = Number(session.completionPercent || 0);
    if (completionPercent - prev >= 10) {
      await writeAuditEvent({
        type: AUDIT_EVENT.PLAYBACK_PROGRESS,
        sessionId,
        inviteId: session.inviteId,
        representativeId: session.representativeId,
        actorUid: uid,
        actorType: "client",
        ipAddress: ip,
        payload: { completionPercent, maxWatchedSeconds },
      });
      await writePresentationActivity({
        sessionId,
        inviteId: session.inviteId,
        companyId: (session.companyId as string) || null,
        representativeId: session.representativeId,
        type: ACTIVITY_EVENT.PROGRESS_UPDATE,
        severity: ACTIVITY_SEVERITY.SUCCESS,
        description: `Playback reached ${Math.round(completionPercent)}%.`,
        env: parseUserAgent(request.rawRequest?.headers["user-agent"] || ""),
        ipAddress: ip,
        actorType: "client",
        actorUid: uid,
        payload: { completionPercent, maxWatchedSeconds },
      });
    }

    const reached =
      duration > 0 && maxWatchedSeconds / duration >= VIDEO_COMPLETION_THRESHOLD;
    if (reached) {
      await finalizeCompletion({
        sessionRef,
        session,
        sessionId,
        videoId,
        uid,
        ip,
        completionPercent: Math.max(
          completionPercent,
          100 * VIDEO_COMPLETION_THRESHOLD,
        ),
        maxWatchedSeconds,
      });
      return { ok: true, completed: true, completionPercent };
    }

    return { ok: true, completed: false, completionPercent };
});

export const completeVideo = onCall(async (request) => {
    const sessionId = String(request.data?.sessionId || "");
    const deviceId = String(request.data?.deviceId || "");
    const uid = requireClientSession(request, sessionId);
    const ip = clientIpFromRequest(request.rawRequest?.headers["x-forwarded-for"]);
    const { sessionRef, session, videoId } = await loadEligibleSession(
      sessionId,
      deviceId,
    );
    await assertLeaseAllowsDevice(sessionId, deviceId, { requireActiveLease: true });

    await finalizeCompletion({
      sessionRef,
      session,
      sessionId,
      videoId,
      uid,
      ip,
      completionPercent: 100,
      maxWatchedSeconds: Number(session.maxWatchedSeconds || 0),
    });

    return { ok: true, completed: true };
});

async function finalizeCompletion(input: {
  sessionRef: DocumentReference;
  session: DocumentData;
  sessionId: string;
  videoId: string;
  uid: string;
  ip: string;
  completionPercent: number;
  maxWatchedSeconds: number;
}) {
  const { sessionRef, session, sessionId, videoId, uid, ip } = input;
  const timeLimited = isTimeLimitedPolicy(session.accessPolicy);
  const consumeEntitlement = shouldConsumeViewingEntitlementOnCompletion(
    session.accessPolicy,
  );

  if (consumeEntitlement) {
    assertSessionAccessible(session);
  }

  const completedAt = new Date().toISOString();

  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(sessionRef);
    const status = fresh.data()?.status as SessionStatus | undefined;
    if (!status) return;
    if (consumeEntitlement && (status === SESSION_STATUS.COMPLETED || status === SESSION_STATUS.CLOSED)) {
      return;
    }
    tx.update(sessionRef, {
      status: SESSION_STATUS.COMPLETED,
      completedAt,
      closedAt: completedAt,
      completionPercent: input.completionPercent,
      maxWatchedSeconds: input.maxWatchedSeconds,
      viewingEntitlementConsumed: consumeEntitlement,
      "analytics.completionPercent": input.completionPercent,
      "analytics.completionTime": completedAt,
      "analytics.watchDurationMs": Math.round(input.maxWatchedSeconds * 1000),
      updatedAt: completedAt,
      updatedAtServer: FieldValue.serverTimestamp(),
    });
    if (!timeLimited) {
      tx.update(db.collection("invites").doc(session.inviteId), {
        status: INVITE_STATUS.COMPLETED,
      });
    }
  });

  if (timeLimited) {
    await writePresentationActivity({
      sessionId,
      inviteId: session.inviteId,
      companyId: (session.companyId as string) || null,
      representativeId: session.representativeId,
      type: ACTIVITY_EVENT.PRESENTATION_COMPLETED,
      severity: ACTIVITY_SEVERITY.SUCCESS,
      description: "Presentation viewing completed (replay still available until expiration).",
      ipAddress: ip,
      actorType: "client",
      actorUid: uid,
      payload: { completedAt, videoId },
    });
    return;
  }

  await markLeaseConsumed(sessionId);

  if (session.contactId) {
    try {
      await db.collection("contacts").doc(String(session.contactId)).update({
        status: CONTACT_STATUS.PRESENTATION_COMPLETED,
        lastSessionId: sessionId,
        updatedAt: completedAt,
        updatedAtServer: FieldValue.serverTimestamp(),
      });
    } catch {
      // non-fatal — contact may have been deleted
    }
  }

  try {
    await auth.updateUser(uid, { disabled: true });
  } catch {
    // non-fatal
  }

  await writeAuditEvent({
    type: AUDIT_EVENT.VIDEO_COMPLETED,
    sessionId,
    inviteId: session.inviteId,
    representativeId: session.representativeId,
    actorUid: uid,
    actorType: "client",
    ipAddress: ip,
    payload: { completedAt, videoId },
  });
  await writePresentationActivity({
    sessionId,
    inviteId: session.inviteId,
    companyId: (session.companyId as string) || null,
    representativeId: session.representativeId,
    type: ACTIVITY_EVENT.VIEWING_ENTITLEMENT_CONSUMED,
    severity: ACTIVITY_SEVERITY.INFO,
    description: "Single-viewing entitlement consumed after successful completion.",
    ipAddress: ip,
    actorType: "system",
    payload: { completedAt, videoId },
  });
  await writePresentationActivity({
    sessionId,
    inviteId: session.inviteId,
    companyId: (session.companyId as string) || null,
    representativeId: session.representativeId,
    type: ACTIVITY_EVENT.PRESENTATION_COMPLETED,
    severity: ACTIVITY_SEVERITY.SUCCESS,
    description: "Presentation completed successfully.",
    ipAddress: ip,
    actorType: "client",
    actorUid: uid,
    payload: { completedAt, videoId },
  });
  await writePresentationActivity({
    sessionId,
    inviteId: session.inviteId,
    companyId: (session.companyId as string) || null,
    representativeId: session.representativeId,
    type: ACTIVITY_EVENT.COMPLETION_RECORDED,
    severity: ACTIVITY_SEVERITY.SUCCESS,
    description: "Completion was recorded and the invitation was closed.",
    ipAddress: ip,
    actorType: "system",
    actorUid: uid,
    payload: { completedAt, videoId },
  });
  await writeAuditEvent({
    type: AUDIT_EVENT.SESSION_CLOSED,
    sessionId,
    inviteId: session.inviteId,
    representativeId: session.representativeId,
    actorUid: uid,
    actorType: "system",
    ipAddress: ip,
    payload: { reason: "video_completed", permanentlyConsumed: true },
  });
  await writeAnalyticsEvent({
    sessionId,
    representativeId: session.representativeId,
    metric: "completion_time",
    value: completedAt,
    videoVersionId: videoId,
  });

  const repSnap = await db.collection("users").doc(session.representativeId).get();
  const repEmail = (repSnap.data()?.email as string) || "";
  const origin = resolveAppOrigin(null);
  const sessionUrl = origin
    ? `${origin}/app/sessions/${sessionId}`
    : `/app/sessions/${sessionId}`;
  const followUpUrl = `${sessionUrl}?followUp=1`;

  if (repEmail) {
    try {
      const result = await sendCompletionEmail({
        to: repEmail,
        clientName: session.clientName,
        completionTimeIso: completedAt,
        sessionUrl,
        followUpUrl,
      });
      await writeAuditEvent({
        type: result.sent ? AUDIT_EVENT.EMAIL_SENT : AUDIT_EVENT.EMAIL_FAILED,
        sessionId,
        inviteId: session.inviteId,
        representativeId: session.representativeId,
        actorType: "system",
        payload: { template: "client_completed", ...result },
      });
    } catch (err) {
      await writeAuditEvent({
        type: AUDIT_EVENT.EMAIL_FAILED,
        sessionId,
        inviteId: session.inviteId,
        representativeId: session.representativeId,
        actorType: "system",
        payload: {
          template: "client_completed",
          error: err instanceof Error ? err.message : "unknown",
        },
      });
    }
  }
}
