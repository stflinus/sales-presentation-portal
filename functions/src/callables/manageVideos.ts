import { FieldValue, type Transaction } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import {
  AUDIT_EVENT,
  MAX_VIDEO_UPLOAD_SIZE,
  PERMISSIONS,
  VIDEO_STATUS,
  VIDEO_PROCESSING_STATUS,
  VIDEO_ARCHIVE_RECOVERY_MS,
  isTimeLimitedPolicy,
  type VideoStatus,
} from "../shared";
import {
  assertHasPermission,
  loadStaffContext,
  resolveActingCompanyId,
} from "../lib/authz";
import { writeAuditEvent } from "../lib/audit";
import { bucket, db } from "../lib/firebase";
import { getPortalSettings } from "../lib/settings";

function maxUploadBytes(): number {
  const raw = Number(process.env.VIDEO_MAX_UPLOAD_BYTES || "");
  return Number.isFinite(raw) && raw > 0 ? raw : MAX_VIDEO_UPLOAD_SIZE;
}

async function resolveCompany(request: import("firebase-functions/v2/https").CallableRequest) {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.VIDEOS_MANAGE);
  let requested =
    typeof request.data?.companyId === "string" ? request.data.companyId : null;
  if (!requested && ctx.isPlatformAdmin && !ctx.companyId) {
    const settings = await getPortalSettings();
    requested = settings.defaultCompanyId || null;
  }
  const companyId = resolveActingCompanyId(ctx, requested);
  return { ctx, companyId };
}

async function nextVersionNumber(company: string): Promise<string> {
  const snap = await db
    .collection("videos")
    .where("companyId", "==", company)
    .get();
  const count = snap.docs.filter((d) => d.data()?.deleted !== true).length;
  return `v${count + 1}`;
}

async function writeVersionHistory(input: {
  videoId: string;
  versionNumber: string;
  uploadDate: string;
  uploadedBy: string;
  companyId: string;
  status: VideoStatus;
  replacementReason?: string | null;
}) {
  const ref = db.collection("videoVersionHistory").doc();
  await ref.set({
    id: ref.id,
    ...input,
    createdAt: new Date().toISOString(),
    createdAtServer: FieldValue.serverTimestamp(),
  });
}

function assertNotDeleted(data: Record<string, unknown> | undefined) {
  if (!data || data.status === VIDEO_STATUS.DELETED || data.deleted === true) {
    throw new HttpsError("failed-precondition", "Video is deleted.");
  }
}

async function syncCompanyDefaultVideoId(
  tx: Transaction,
  companyId: string,
  excludeVideoId?: string,
): Promise<void> {
  const companyRef = db.collection("companies").doc(companyId);
  const companySnap = await tx.get(companyRef);
  if (!companySnap.exists) return;
  const current = String(companySnap.data()?.activeVideoId || "").trim();
  if (current && current !== excludeVideoId) {
    const currentSnap = await tx.get(db.collection("videos").doc(current));
    const currentData = currentSnap.data();
    if (
      currentSnap.exists &&
      currentData?.status === VIDEO_STATUS.ACTIVE &&
      currentData?.active === true
    ) {
      return;
    }
  }
  const activeSnap = await tx.get(
    db
      .collection("videos")
      .where("companyId", "==", companyId)
      .where("status", "==", VIDEO_STATUS.ACTIVE)
      .limit(20),
  );
  const nextId =
    activeSnap.docs.find((d) => d.id !== excludeVideoId)?.id ?? null;
  tx.set(
    companyRef,
    {
      activeVideoId: nextId || "",
      updatedAt: new Date().toISOString(),
      updatedAtServer: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/** Create a draft video record and return the Storage path for client upload. */
export const createVideoDraft = onCall(async (request) => {
  const title = String(request.data?.title || "Presentation").trim();
  const description = String(request.data?.description || "").trim();
  if (!title) throw new HttpsError("invalid-argument", "title required.");

  const { ctx, companyId: company } = await resolveCompany(request);
  const uid = ctx.uid;
  const versionNumber = await nextVersionNumber(company);
  const ref = db.collection("videos").doc();
  const storagePath = `videos/${ref.id}/source.mp4`;
  const nowIso = new Date().toISOString();

  await ref.set({
    id: ref.id,
    title,
    description,
    companyId: company,
    versionNumber,
    uploadDate: nowIso,
    uploadedBy: uid,
    storagePath,
    fileSize: null,
    durationSeconds: null,
    thumbnailPath: null,
    status: VIDEO_STATUS.DRAFT,
    active: false,
    archived: false,
    deleted: false,
    allowExistingSessions: false,
    replacementReason: null,
    contentType: "video/mp4",
    sizeBytes: null,
    campaignIds: [],
    isPlaceholder: false,
    createdAt: nowIso,
    createdBy: uid,
    activatedAt: null,
    createdAtServer: FieldValue.serverTimestamp(),
  });

  await writeVersionHistory({
    videoId: ref.id,
    versionNumber,
    uploadDate: nowIso,
    uploadedBy: uid,
    companyId: company,
    status: VIDEO_STATUS.DRAFT,
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.VIDEO_UPLOADED,
    actorUid: uid,
    actorType: "administrator",
    payload: {
      action: "video_draft_created",
      videoId: ref.id,
      companyId: company,
      versionNumber,
      storagePath,
    },
  });

  return {
    id: ref.id,
    storagePath,
    versionNumber,
    companyId: company,
    maxUploadBytes: maxUploadBytes(),
    contentType: "video/mp4",
  };
});

/** Finalize metadata after the MP4 is in Storage. */
export const finalizeVideoUpload = onCall(
  { timeoutSeconds: 120 },
  async (request) => {
  const { ctx, companyId: company } = await resolveCompany(request);
  const uid = ctx.uid;
  const videoId = String(request.data?.videoId || "").trim();
  const durationSeconds =
    request.data?.durationSeconds == null
      ? null
      : Number(request.data.durationSeconds);
  if (!videoId) throw new HttpsError("invalid-argument", "videoId required.");

  logger.info("video_finalize_start", { videoId, uid, company });

  const ref = db.collection("videos").doc(videoId);
  const snap = await ref.get();
  if (!snap.exists) {
    logger.warn("video_finalize_failed", { videoId, reason: "not_found" });
    throw new HttpsError("not-found", "Video not found.");
  }
  const data = snap.data()!;
  assertNotDeleted(data);
  if (data.companyId && data.companyId !== company) {
    logger.warn("video_finalize_failed", {
      videoId,
      reason: "company_mismatch",
    });
    throw new HttpsError("permission-denied", "Video belongs to another company.");
  }

  const storagePath = String(data.storagePath || "");
  if (!storagePath) {
    logger.warn("video_finalize_failed", {
      videoId,
      reason: "missing_storage_path",
    });
    throw new HttpsError(
      "failed-precondition",
      "Video has no Storage path. Create a new draft and upload again.",
    );
  }

  const file = bucket.file(storagePath);
  // Brief retry — large uploads can lag briefly before metadata is visible.
  let exists = false;
  let metadata: { size?: string | number; contentType?: string } | null = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const [fileExists] = await file.exists();
    if (fileExists) {
      exists = true;
      const [meta] = await file.getMetadata();
      metadata = meta;
      break;
    }
    logger.info("video_finalize_storage_wait", { videoId, storagePath, attempt });
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  if (!exists || !metadata) {
    logger.warn("video_finalize_failed", {
      videoId,
      reason: "storage_object_missing",
      storagePath,
      bucket: bucket.name,
    });
    throw new HttpsError(
      "failed-precondition",
      "Upload the MP4 to Storage before finalizing.",
    );
  }
  const sizeBytes = Number(metadata.size || 0);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    logger.warn("video_finalize_failed", {
      videoId,
      reason: "invalid_size",
      sizeBytes,
    });
    throw new HttpsError(
      "failed-precondition",
      "Uploaded file has an invalid size. Retry the upload.",
    );
  }
  if (sizeBytes > maxUploadBytes()) {
    logger.warn("video_finalize_failed", {
      videoId,
      reason: "too_large",
      sizeBytes,
      max: maxUploadBytes(),
    });
    throw new HttpsError(
      "invalid-argument",
      `File exceeds maximum size of ${maxUploadBytes()} bytes.`,
    );
  }
  const contentType = String(metadata.contentType || "video/mp4");
  if (!contentType.startsWith("video/")) {
    logger.warn("video_finalize_failed", {
      videoId,
      reason: "invalid_content_type",
      contentType,
    });
    throw new HttpsError("invalid-argument", "Uploaded object must be a video.");
  }

  const nowIso = new Date().toISOString();
  await ref.update({
    fileSize: sizeBytes,
    sizeBytes,
    contentType,
    durationSeconds:
      durationSeconds != null && Number.isFinite(durationSeconds)
        ? durationSeconds
        : data.durationSeconds ?? null,
    uploadDate: nowIso,
    uploadedBy: uid,
    status: VIDEO_STATUS.DRAFT,
    active: false,
    uploadFinalizedAt: nowIso,
    // Queue video for async processing pipeline
    "processing.status": VIDEO_PROCESSING_STATUS.UPLOADED,
    updatedAt: nowIso,
    updatedAtServer: FieldValue.serverTimestamp(),
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.VIDEO_UPLOADED,
    actorUid: uid,
    actorType: "administrator",
    payload: {
      action: "video_upload_finalized",
      videoId,
      companyId: data.companyId,
      versionNumber: data.versionNumber,
      fileSize: sizeBytes,
    },
  });

  logger.info("video_finalize_ok", { videoId, fileSize: sizeBytes, contentType });
  return { ok: true, videoId, fileSize: sizeBytes, contentType };
});

/** List non-deleted videos for the company (includes archived). */
export const listVideos = onCall(async (request) => {
  const { companyId: company } = await resolveCompany(request);
  const includeDeleted = request.data?.includeDeleted === true;
  const snap = await db.collection("videos").where("companyId", "==", company).get();
  const videos = snap.docs
    .map((d) => {
      const data = d.data() as Record<string, unknown>;
      return { id: d.id, ...data };
    })
    .filter((v: Record<string, unknown>) => includeDeleted || v.deleted !== true)
    .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
      String(a.uploadDate || "").localeCompare(String(b.uploadDate || "")) * -1,
    );
  return { videos, companyId: company, maxUploadBytes: maxUploadBytes() };
});

export const activateVideo = onCall(async (request) => {
  const videoId = String(request.data?.videoId || "").trim();
  const replacementReason =
    typeof request.data?.replacementReason === "string"
      ? String(request.data.replacementReason).trim()
      : null;
  if (!videoId) throw new HttpsError("invalid-argument", "videoId required.");

  const { ctx, companyId: company } = await resolveCompany(request);
  const uid = ctx.uid;
  const ref = db.collection("videos").doc(videoId);
  const nowIso = new Date().toISOString();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Video not found.");
    const data = snap.data()!;
    if (data.companyId !== company) {
      throw new HttpsError("permission-denied", "Video belongs to another company.");
    }
    if (data.deleted === true || data.status === VIDEO_STATUS.DELETED) {
      throw new HttpsError("failed-precondition", "Cannot activate a deleted video.");
    }
    if (data.permanentlyDeletedAt || data.tombstone === true) {
      throw new HttpsError("failed-precondition", "Cannot activate a permanently deleted video.");
    }
    // Allow activating restored videos (archived=false after restore)
    // Block activating still-archived videos
    if (data.archived === true || data.status === VIDEO_STATUS.ARCHIVED) {
      throw new HttpsError("failed-precondition", "Restore the video from archive before activating.");
    }
    if (!data.storagePath) {
      throw new HttpsError(
        "failed-precondition",
        "Finalize the upload before activating.",
      );
    }
    const fileSize = data.fileSize ?? data.sizeBytes;
    if (fileSize == null || Number(fileSize) <= 0) {
      throw new HttpsError(
        "failed-precondition",
        "Finalize the upload before activating.",
      );
    }

    const companyRef = db.collection("companies").doc(company);
    const companySnap = await tx.get(companyRef);
    const currentDefault = String(companySnap.data()?.activeVideoId || "").trim();
    let shouldSetDefault = !currentDefault;
    if (currentDefault) {
      const defaultSnap = await tx.get(db.collection("videos").doc(currentDefault));
      const defaultData = defaultSnap.data();
      if (
        !defaultSnap.exists ||
        defaultData?.status !== VIDEO_STATUS.ACTIVE ||
        defaultData?.active !== true
      ) {
        shouldSetDefault = true;
      }
    }

    tx.update(ref, {
      status: VIDEO_STATUS.ACTIVE,
      active: true,
      archived: false,
      deleted: false,
      allowExistingSessions: true,
      activatedAt: nowIso,
      deactivatedAt: null,
      // Clear any archive-related fields on activation
      archivedAt: null,
      scheduledPermanentDeletionAt: null,
      deletionPostponedUntil: null,
      deletionPostponedReason: null,
      replacementReason: replacementReason || null,
      updatedAt: nowIso,
      updatedAtServer: FieldValue.serverTimestamp(),
    });

    if (shouldSetDefault) {
      tx.set(
        companyRef,
        {
          activeVideoId: videoId,
          updatedAt: nowIso,
          updatedAtServer: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      tx.set(
        db.collection("settings").doc("portal"),
        { activeVideoId: videoId, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }
  });

  const after = (await ref.get()).data()!;
  await writeVersionHistory({
    videoId,
    versionNumber: String(after.versionNumber),
    uploadDate: String(after.uploadDate || nowIso),
    uploadedBy: uid,
    companyId: company,
    status: VIDEO_STATUS.ACTIVE,
    replacementReason,
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.VIDEO_ACTIVATED,
    actorUid: uid,
    actorType: "administrator",
    payload: {
      videoId,
      companyId: company,
      versionNumber: after.versionNumber,
      replacementReason,
    },
  });

  return { ok: true, videoId, active: true };
});

export const deactivateVideo = onCall(async (request) => {
  const videoId = String(request.data?.videoId || "").trim();
  if (!videoId) throw new HttpsError("invalid-argument", "videoId required.");
  const { ctx, companyId: company } = await resolveCompany(request);
  const uid = ctx.uid;
  const nowIso = new Date().toISOString();
  const ref = db.collection("videos").doc(videoId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Video not found.");
    const data = snap.data()!;
    if (data.companyId !== company) {
      throw new HttpsError("permission-denied", "Video belongs to another company.");
    }
    assertNotDeleted(data);
    await syncCompanyDefaultVideoId(tx, company, videoId);
    tx.update(ref, {
      status: VIDEO_STATUS.INACTIVE,
      active: false,
      allowExistingSessions: false,
      deactivatedAt: nowIso,
      updatedAt: nowIso,
      updatedAtServer: FieldValue.serverTimestamp(),
    });
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.VIDEO_DEACTIVATED,
    actorUid: uid,
    actorType: "administrator",
    payload: { videoId, companyId: company },
  });

  return { ok: true, videoId, status: VIDEO_STATUS.INACTIVE };
});

export const archiveVideo = onCall(async (request) => {
  const videoId = String(request.data?.videoId || "").trim();
  if (!videoId) throw new HttpsError("invalid-argument", "videoId required.");
  const { ctx, companyId: company } = await resolveCompany(request);
  const uid = ctx.uid;
  const nowIso = new Date().toISOString();
  const scheduledDeletionAt = new Date(Date.now() + VIDEO_ARCHIVE_RECOVERY_MS).toISOString();
  const ref = db.collection("videos").doc(videoId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Video not found.");
    const data = snap.data()!;
    if (data.companyId !== company) {
      throw new HttpsError("permission-denied", "Video belongs to another company.");
    }
    assertNotDeleted(data);
    await syncCompanyDefaultVideoId(tx, company, videoId);
    tx.update(ref, {
      status: VIDEO_STATUS.ARCHIVED,
      active: false,
      archived: true,
      // allowExistingSessions: true — existing clients may continue
      allowExistingSessions: true,
      archivedAt: nowIso,
      scheduledPermanentDeletionAt: scheduledDeletionAt,
      deletionPostponedUntil: null,
      deletionPostponedReason: null,
      updatedAt: nowIso,
      updatedAtServer: FieldValue.serverTimestamp(),
    });
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.VIDEO_ARCHIVED,
    actorUid: uid,
    actorType: "administrator",
    payload: { videoId, companyId: company },
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.VIDEO_DELETION_SCHEDULED,
    actorUid: uid,
    actorType: "administrator",
    payload: {
      videoId,
      companyId: company,
      scheduledPermanentDeletionAt: scheduledDeletionAt,
      recoveryDays: 30,
    },
  });

  return {
    ok: true,
    videoId,
    status: VIDEO_STATUS.ARCHIVED,
    scheduledPermanentDeletionAt: scheduledDeletionAt,
  };
});

/** Restore a video from archive (before permanent deletion). */
export const restoreVideo = onCall(async (request) => {
  const videoId = String(request.data?.videoId || "").trim();
  if (!videoId) throw new HttpsError("invalid-argument", "videoId required.");
  const { ctx, companyId: company } = await resolveCompany(request);
  const uid = ctx.uid;
  const nowIso = new Date().toISOString();
  const ref = db.collection("videos").doc(videoId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Video not found.");
    const data = snap.data()!;
    if (data.companyId !== company) {
      throw new HttpsError("permission-denied", "Video belongs to another company.");
    }
    // Must be archived
    if (data.archived !== true && data.status !== VIDEO_STATUS.ARCHIVED) {
      throw new HttpsError("failed-precondition", "Video is not archived.");
    }
    // Must not be permanently deleted
    if (data.permanentlyDeletedAt || data.tombstone === true) {
      throw new HttpsError("failed-precondition", "Video has been permanently deleted and cannot be restored.");
    }
    tx.update(ref, {
      status: VIDEO_STATUS.INACTIVE, // Admin must reactivate manually
      active: false,
      archived: false,
      archivedAt: null,
      scheduledPermanentDeletionAt: null,
      deletionPostponedUntil: null,
      deletionPostponedReason: null,
      restoredAt: nowIso,
      allowExistingSessions: true,
      updatedAt: nowIso,
      updatedAtServer: FieldValue.serverTimestamp(),
    });
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.VIDEO_RESTORED,
    actorUid: uid,
    actorType: "administrator",
    payload: { videoId, companyId: company },
  });

  return { ok: true, videoId, status: VIDEO_STATUS.INACTIVE, restoredAt: nowIso };
});

/**
 * Check if any active sessions block video permanent deletion.
 * Returns { safe: true } if deletion is safe, or { safe: false, reason, sessions } if blocked.
 */
async function assertVideoSafeToPermanentlyDelete(videoId: string): Promise<{
  safe: boolean;
  reason?: string;
  activeSessionCount?: number;
}> {
  const nowMs = Date.now();
  
  // Query sessions for this video
  const sessionsSnap = await db.collection("presentationSessions")
    .where("videoId", "==", videoId)
    .limit(100)
    .get();

  let activeCount = 0;
  
  for (const doc of sessionsSnap.docs) {
    const session = doc.data();
    const expiresAt = session.expiresAt ? new Date(session.expiresAt).getTime() : 0;
    const status = session.status as string;
    const accessPolicy = session.accessPolicy;
    const viewingEntitlementConsumed = session.viewingEntitlementConsumed === true;
    
    // Terminal states that don't block deletion
    const terminalStatuses = ["completed", "closed", "revoked", "expired"];
    if (terminalStatuses.includes(status)) {
      // For single_view: terminal means done
      if (!isTimeLimitedPolicy(accessPolicy)) {
        continue;
      }
      // For time_limited: still check expiration
    }
    
    // Check based on policy type
    if (isTimeLimitedPolicy(accessPolicy)) {
      // Time-limited: active if expiresAt > now
      if (expiresAt > nowMs) {
        activeCount++;
      }
    } else {
      // Single-view: active if not consumed and status not terminal
      if (!viewingEntitlementConsumed && !terminalStatuses.includes(status)) {
        activeCount++;
      }
    }
  }
  
  if (activeCount > 0) {
    return {
      safe: false,
      reason: `${activeCount} active session(s) are still using this video. Wait for sessions to expire or complete before permanent deletion.`,
      activeSessionCount: activeCount,
    };
  }
  
  return { safe: true };
}

/**
 * Perform permanent deletion of a video.
 * Shared helper for manual deletion and scheduled cleanup.
 */
export async function performPermanentVideoDeletion(
  videoId: string,
  actorUid: string,
): Promise<{ ok: boolean; videoId: string }> {
  const ref = db.collection("videos").doc(videoId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Video not found.");
  }
  
  const data = snap.data()!;
  const nowIso = new Date().toISOString();
  
  // Cancel any ongoing processing
  const currentGeneration = (data.processing?.generation as number) ?? 0;
  
  // Delete Storage objects
  const pathsToDelete: string[] = [];
  if (data.storagePath) pathsToDelete.push(String(data.storagePath));
  if (data.optimizedStoragePath) pathsToDelete.push(String(data.optimizedStoragePath));
  if (data.playbackStoragePath && data.playbackStoragePath !== data.optimizedStoragePath) {
    pathsToDelete.push(String(data.playbackStoragePath));
  }
  if (data.thumbnailPath) pathsToDelete.push(String(data.thumbnailPath));
  
  // Also delete any generation-specific optimized files
  try {
    const [files] = await bucket.getFiles({ prefix: `videos/${videoId}/` });
    for (const file of files) {
      if (!pathsToDelete.includes(file.name)) {
        pathsToDelete.push(file.name);
      }
    }
  } catch (err) {
    logger.warn("list_video_files_failed", { videoId, error: String(err) });
  }
  
  // Delete all storage files
  for (const p of pathsToDelete) {
    try {
      await bucket.file(p).delete({ ignoreNotFound: true });
    } catch (err) {
      logger.warn("delete_video_file_failed", { videoId, path: p, error: String(err) });
    }
  }
  
  // Convert Firestore doc to tombstone
  await ref.update({
    status: VIDEO_STATUS.DELETED,
    deleted: true,
    tombstone: true,
    permanentlyDeletedAt: nowIso,
    deletedBy: actorUid,
    active: false,
    archived: false,
    allowExistingSessions: false,
    // Clear storage paths
    storagePath: null,
    optimizedStoragePath: null,
    playbackStoragePath: null,
    thumbnailPath: null,
    // Keep minimal info: id, title, archivedAt, companyId
    // Clear large processing blobs but keep probe summary
    "processing.cancelled": true,
    "processing.generation": currentGeneration + 1,
    updatedAt: nowIso,
    updatedAtServer: FieldValue.serverTimestamp(),
  });
  
  await writeAuditEvent({
    type: AUDIT_EVENT.VIDEO_PERMANENTLY_DELETED,
    actorUid,
    actorType: "administrator",
    payload: {
      videoId,
      companyId: data.companyId,
      deletedFiles: pathsToDelete.length,
    },
  });
  
  logger.info("video_permanently_deleted", {
    videoId,
    companyId: data.companyId,
    deletedFiles: pathsToDelete.length,
    by: actorUid,
  });
  
  return { ok: true, videoId };
}

export const deleteVideo = onCall(async (request) => {
  const videoId = String(request.data?.videoId || "").trim();
  const permanent = request.data?.permanent === true;
  const confirm = request.data?.confirm === true;
  if (!videoId) throw new HttpsError("invalid-argument", "videoId required.");
  const { ctx, companyId: company } = await resolveCompany(request);
  const uid = ctx.uid;
  const nowIso = new Date().toISOString();
  const ref = db.collection("videos").doc(videoId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Video not found.");
  const data = snap.data()!;
  if (data.companyId !== company) {
    throw new HttpsError("permission-denied", "Video belongs to another company.");
  }
  
  // Already a tombstone
  if (data.tombstone === true || data.permanentlyDeletedAt) {
    throw new HttpsError("failed-precondition", "Video has already been permanently deleted.");
  }
  
  // Soft delete path
  if (!permanent) {
    if (data.status === VIDEO_STATUS.ACTIVE || data.active === true) {
      throw new HttpsError(
        "failed-precondition",
        "Deactivate the active video before deleting it.",
      );
    }
    await ref.update({
      status: VIDEO_STATUS.DELETED,
      active: false,
      deleted: true,
      allowExistingSessions: false,
      deletedAt: nowIso,
      updatedAt: nowIso,
      updatedAtServer: FieldValue.serverTimestamp(),
    });
    await writeAuditEvent({
      type: AUDIT_EVENT.VIDEO_DELETED,
      actorUid: uid,
      actorType: "administrator",
      payload: { videoId, companyId: company, permanent: false },
    });
    return { ok: true, videoId, status: VIDEO_STATUS.DELETED, permanent: false };
  }

  // Permanent deletion path
  // Require VIDEOS_PERMANENT_DELETE permission
  assertHasPermission(ctx, PERMISSIONS.VIDEOS_PERMANENT_DELETE);
  
  if (!confirm) {
    throw new HttpsError(
      "failed-precondition",
      "Permanent deletion requires confirm: true.",
    );
  }
  
  // Must be archived or soft-deleted first
  const isArchivedOrDeleted = 
    data.archived === true || 
    data.status === VIDEO_STATUS.ARCHIVED ||
    data.deleted === true ||
    data.status === VIDEO_STATUS.DELETED;
    
  if (!isArchivedOrDeleted) {
    throw new HttpsError(
      "failed-precondition",
      "Archive or soft-delete the video before permanent deletion.",
    );
  }
  
  // Safety check: no active sessions
  const safetyCheck = await assertVideoSafeToPermanentlyDelete(videoId);
  if (!safetyCheck.safe) {
    // Postpone deletion
    const postponeUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await ref.update({
      deletionPostponedUntil: postponeUntil,
      deletionPostponedReason: safetyCheck.reason,
      updatedAt: nowIso,
      updatedAtServer: FieldValue.serverTimestamp(),
    });
    
    await writeAuditEvent({
      type: AUDIT_EVENT.VIDEO_DELETION_POSTPONED,
      actorUid: uid,
      actorType: "administrator",
      payload: {
        videoId,
        companyId: company,
        reason: safetyCheck.reason,
        activeSessionCount: safetyCheck.activeSessionCount,
        postponedUntil: postponeUntil,
      },
    });
    
    return {
      ok: false,
      videoId,
      permanent: false,
      postponed: true,
      reason: safetyCheck.reason,
      activeSessionCount: safetyCheck.activeSessionCount,
    };
  }

  return performPermanentVideoDeletion(videoId, uid);
});

/** Admin preview: short-lived signed URL (never exposed to clients via listing). */
export const getAdminVideoPreviewUrl = onCall(async (request) => {
  const { ctx, companyId: company } = await resolveCompany(request);
  const videoId = String(request.data?.videoId || "").trim();
  if (!videoId) throw new HttpsError("invalid-argument", "videoId required.");
  const snap = await db.collection("videos").doc(videoId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Video not found.");
  const data = snap.data()!;
  if (!ctx.isPlatformAdmin && data.companyId && data.companyId !== company) {
    throw new HttpsError("permission-denied", "Video belongs to another company.");
  }
  assertNotDeleted(data);
  const file = bucket.file(String(data.storagePath));
  const [exists] = await file.exists();
  if (!exists) throw new HttpsError("failed-precondition", "Video file missing in Storage.");
  const [url] = await file.getSignedUrl({
    action: "read",
    expires: Date.now() + 10 * 60 * 1000,
    version: "v4",
  });
  return {
    videoUrl: url,
    expiresInSeconds: 600,
    title: data.title,
    versionNumber: data.versionNumber,
    status: data.status,
  };
});

/** Update display title (and optional description) after upload. */
export const updateVideoMetadata = onCall(async (request) => {
  const videoId = String(request.data?.videoId || "").trim();
  const title = String(request.data?.title || "").trim();
  const descriptionProvided = request.data?.description != null;
  const description = descriptionProvided
    ? String(request.data.description || "").trim()
    : undefined;
  if (!videoId) throw new HttpsError("invalid-argument", "videoId required.");
  if (!title || title.length > 200) {
    throw new HttpsError("invalid-argument", "A valid title is required (max 200 characters).");
  }
  if (description !== undefined && description.length > 2000) {
    throw new HttpsError(
      "invalid-argument",
      "Description must be 2000 characters or fewer.",
    );
  }

  const { ctx, companyId: company } = await resolveCompany(request);
  const uid = ctx.uid;
  const ref = db.collection("videos").doc(videoId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Video not found.");
  const data = snap.data()!;
  if (data.companyId !== company) {
    throw new HttpsError("permission-denied", "Video belongs to another company.");
  }
  assertNotDeleted(data);

  const nowIso = new Date().toISOString();
  const updates: Record<string, unknown> = {
    title,
    updatedAt: nowIso,
    updatedAtServer: FieldValue.serverTimestamp(),
  };
  if (descriptionProvided) {
    updates.description = description;
  }

  await ref.update(updates);

  await writeAuditEvent({
    type: AUDIT_EVENT.VIDEO_UPLOADED,
    actorUid: uid,
    actorType: "administrator",
    payload: {
      action: "video_metadata_updated",
      videoId,
      companyId: company,
      title,
    },
  });

  return { ok: true, videoId, title };
});
