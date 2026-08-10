import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import {
  AUDIT_EVENT,
  MAX_VIDEO_UPLOAD_SIZE,
  PERMISSIONS,
  VIDEO_STATUS,
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
    if (data.archived === true || data.status === VIDEO_STATUS.ARCHIVED) {
      throw new HttpsError("failed-precondition", "Restore from archive is not supported; upload a new version.");
    }
    if (!data.storagePath || data.fileSize == null) {
      throw new HttpsError(
        "failed-precondition",
        "Finalize the upload before activating.",
      );
    }

    const active = await tx.get(
      db
        .collection("videos")
        .where("companyId", "==", company)
        .where("status", "==", VIDEO_STATUS.ACTIVE)
        .limit(20),
    );
    for (const docSnap of active.docs) {
      if (docSnap.id === videoId) continue;
      tx.update(docSnap.ref, {
        status: VIDEO_STATUS.INACTIVE,
        active: false,
        allowExistingSessions: true,
        deactivatedAt: nowIso,
        replacementReason: replacementReason || "Replaced by newly activated video",
        updatedAt: nowIso,
      });
    }

    tx.update(ref, {
      status: VIDEO_STATUS.ACTIVE,
      active: true,
      archived: false,
      deleted: false,
      allowExistingSessions: true,
      activatedAt: nowIso,
      deactivatedAt: null,
      replacementReason: replacementReason || null,
      updatedAt: nowIso,
      updatedAtServer: FieldValue.serverTimestamp(),
    });
    tx.set(
      db.collection("settings").doc("portal"),
      { activeVideoId: videoId, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    tx.set(
      db.collection("companies").doc(company),
      {
        activeVideoId: videoId,
        updatedAt: nowIso,
        updatedAtServer: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
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
    tx.update(ref, {
      status: VIDEO_STATUS.INACTIVE,
      active: false,
      allowExistingSessions: false,
      deactivatedAt: nowIso,
      updatedAt: nowIso,
      updatedAtServer: FieldValue.serverTimestamp(),
    });
    const settings = await tx.get(db.collection("settings").doc("portal"));
    if (settings.exists && settings.data()?.activeVideoId === videoId) {
      tx.set(
        settings.ref,
        { activeVideoId: "", updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }
    const companyRef = db.collection("companies").doc(company);
    const companySnap = await tx.get(companyRef);
    if (companySnap.exists && companySnap.data()?.activeVideoId === videoId) {
      tx.set(
        companyRef,
        {
          activeVideoId: "",
          updatedAt: nowIso,
          updatedAtServer: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
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
  const ref = db.collection("videos").doc(videoId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Video not found.");
    const data = snap.data()!;
    if (data.companyId !== company) {
      throw new HttpsError("permission-denied", "Video belongs to another company.");
    }
    assertNotDeleted(data);
    tx.update(ref, {
      status: VIDEO_STATUS.ARCHIVED,
      active: false,
      archived: true,
      allowExistingSessions: false,
      archivedAt: nowIso,
      updatedAt: nowIso,
      updatedAtServer: FieldValue.serverTimestamp(),
    });
    const settings = await tx.get(db.collection("settings").doc("portal"));
    if (settings.exists && settings.data()?.activeVideoId === videoId) {
      tx.set(
        settings.ref,
        { activeVideoId: "", updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }
    const companyRef = db.collection("companies").doc(company);
    const companySnap = await tx.get(companyRef);
    if (companySnap.exists && companySnap.data()?.activeVideoId === videoId) {
      tx.set(
        companyRef,
        {
          activeVideoId: "",
          updatedAt: nowIso,
          updatedAtServer: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.VIDEO_ARCHIVED,
    actorUid: uid,
    actorType: "administrator",
    payload: { videoId, companyId: company },
  });

  return { ok: true, videoId, status: VIDEO_STATUS.ARCHIVED };
});

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
  if (data.status === VIDEO_STATUS.ACTIVE || data.active === true) {
    throw new HttpsError(
      "failed-precondition",
      "Deactivate the active video before deleting it.",
    );
  }

  if (!permanent) {
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

  if (!confirm) {
    throw new HttpsError(
      "failed-precondition",
      "Permanent deletion requires confirm: true.",
    );
  }
  if (data.status !== VIDEO_STATUS.DELETED && data.deleted !== true) {
    throw new HttpsError(
      "failed-precondition",
      "Soft-delete the video before permanent deletion.",
    );
  }

  try {
    await bucket.file(String(data.storagePath)).delete({ ignoreNotFound: true });
    if (data.thumbnailPath) {
      await bucket.file(String(data.thumbnailPath)).delete({ ignoreNotFound: true });
    }
  } catch {
    // Continue metadata removal even if storage cleanup fails.
  }
  await ref.delete();
  await writeAuditEvent({
    type: AUDIT_EVENT.VIDEO_DELETED,
    actorUid: uid,
    actorType: "administrator",
    payload: { videoId, companyId: company, permanent: true },
  });
  return { ok: true, videoId, permanent: true };
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
