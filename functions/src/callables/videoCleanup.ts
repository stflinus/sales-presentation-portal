import { FieldValue } from "firebase-admin/firestore";
import { onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import {
  AUDIT_EVENT,
  PERMISSIONS,
  VIDEO_PROCESSING_STATUS,
  VIDEO_PROCESSING_FAILURE_CATEGORY,
  classifyProcessingAbandonment,
  isTimeLimitedPolicy,
} from "../shared";
import { assertHasPermission, loadStaffContext } from "../lib/authz";
import { writeAuditEvent } from "../lib/audit";
import { db } from "../lib/firebase";
import {
  isVideoProcessingStale,
  videoHasActiveProcessingJob,
} from "../lib/videoLifecycle.pure";
import { performPermanentVideoDeletion } from "./manageVideos";
import {
  mergeHistoryOnVideo,
  writeVideoProcessingDiagnostic,
} from "../lib/videoProcessingDiagnostics";
import type { VideoProcessingHistoryEntry } from "../shared";

function generateErrorCode(): string {
  const hex = Math.random().toString(16).slice(2, 8).toUpperCase().padEnd(6, "0");
  return `VID-${hex}`;
}

/**
 * Mark abandoned in-progress processing jobs as Processing Failed.
 * Covers Cloud Function/Cloud Run kills that never reach a catch block.
 */
export async function recoverStaleVideoProcessingJobs(actorUid = "system:stale_sweeper"): Promise<{
  scanned: number;
  recovered: number;
  recoveredIds: string[];
}> {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const snap = await db.collection("videos").get();
  let scanned = 0;
  let recovered = 0;
  const recoveredIds: string[] = [];

  for (const doc of snap.docs) {
    const video = doc.data();
    if (video.deleted === true || video.tombstone === true) continue;
    const processing = video.processing || null;
    if (!isVideoProcessingStale(processing, nowMs)) continue;
    scanned++;

    const errorCode = generateErrorCode();
    const last =
      processing?.lastProgressAt ||
      processing?.startedAt ||
      processing?.queuedAt ||
      processing?.requestedAt ||
      null;
    const failureCategory = classifyProcessingAbandonment({
      startedAt: processing?.startedAt,
      queuedAt: processing?.queuedAt,
      requestedAt: processing?.requestedAt,
      lastProgressAt: processing?.lastProgressAt,
      nowMs,
    });
    const reason =
      failureCategory === VIDEO_PROCESSING_FAILURE_CATEGORY.PROCESSING_TIMEOUT
        ? `PROCESSING_TIMEOUT: processing exceeded the hard 3-hour Cloud Run Job ceiling without completing.`
        : `PROCESSING_STALLED: no meaningful progress heartbeat since ${last || "unknown"} (worker likely stalled or was killed).`;

    const startedAt = processing?.startedAt || processing?.queuedAt || null;
    const elapsedMs = startedAt ? nowMs - new Date(startedAt).getTime() : null;
    const history = mergeHistoryOnVideo(
      processing?.history as VideoProcessingHistoryEntry[] | undefined,
      {
        attempt: (processing?.attempt as number) ?? 1,
        jobId: processing?.jobId ?? null,
        outcome: "failed",
        status: VIDEO_PROCESSING_STATUS.FAILED,
        failureCategory,
        errorCode,
        runtime: processing?.runtime || "cloud_run_job",
        note: reason.slice(0, 240),
        startedAt,
        finishedAt: nowIso,
        progressPercent: processing?.progressPercent ?? null,
        processedSeconds: processing?.processedSeconds ?? null,
        totalSeconds: processing?.totalSeconds ?? null,
      },
    );

    await doc.ref.update({
      "processing.status": VIDEO_PROCESSING_STATUS.FAILED,
      "processing.stage": VIDEO_PROCESSING_STATUS.FAILED,
      "processing.failedAt": nowIso,
      "processing.failureReason": reason,
      "processing.failureCategory": failureCategory,
      "processing.errorCode": errorCode,
      "processing.lastProgressAt": nowIso,
      "processing.stageDetail": "stale_recovered",
      "processing.estimatedRemainingSeconds": null,
      "processing.cancelled": true,
      "processing.generation": ((processing?.generation as number) ?? 0) + 1,
      "processing.history": history,
      updatedAt: nowIso,
      updatedAtServer: FieldValue.serverTimestamp(),
    });

    await writeVideoProcessingDiagnostic({
      videoId: doc.id,
      title: video.title ?? null,
      jobId: processing?.jobId ?? null,
      attempt: processing?.attempt ?? null,
      stage: processing?.stageDetail || processing?.status || "unknown",
      status: VIDEO_PROCESSING_STATUS.FAILED,
      startedAt,
      lastProgressAt: last,
      elapsedMs,
      progressPercent: processing?.progressPercent ?? null,
      processedSeconds: processing?.processedSeconds ?? null,
      totalSeconds: processing?.totalSeconds ?? null,
      sourceDurationSeconds: processing?.totalSeconds ?? null,
      runtime: processing?.runtime || "cloud_run_job",
      terminationReason: failureCategory,
      ffmpegErrorSummary: reason,
      failureCategory,
      errorCode,
      outcome: "failed",
      companyId: video.companyId ?? null,
    });

    await writeAuditEvent({
      type: AUDIT_EVENT.VIDEO_PROCESSING_STALE_RECOVERED,
      actorUid,
      actorType: "system",
      payload: {
        videoId: doc.id,
        companyId: video.companyId ?? null,
        errorCode,
        failureCategory,
        jobId: processing?.jobId ?? null,
        previousStatus: processing?.status ?? null,
        lastProgressAt: last,
        title: video.title ?? null,
      },
    });
    await writeAuditEvent({
      type: AUDIT_EVENT.VIDEO_PROCESSING_FAILED,
      actorUid,
      actorType: "system",
      payload: {
        videoId: doc.id,
        companyId: video.companyId ?? null,
        errorCode,
        failureCategory,
        jobId: processing?.jobId ?? null,
        stage: "stale_recovery",
        error: reason,
      },
    });

    recovered++;
    recoveredIds.push(doc.id);
    logger.warn("video_processing_stale_recovered", {
      videoId: doc.id,
      errorCode,
      failureCategory,
      previousStatus: processing?.status,
      lastProgressAt: last,
    });
  }

  return { scanned, recovered, recoveredIds };
}

/**
 * Scheduled stale-job recovery — every 5 minutes (stall threshold is 10 minutes).
 */
export const recoverStaleVideoProcessing = onSchedule(
  {
    schedule: "every 5 minutes",
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async () => {
    const result = await recoverStaleVideoProcessingJobs();
    logger.info("recover_stale_video_processing_complete", result);
  },
);

/**
 * Manual stale recovery (admin).
 */
export const runStaleVideoProcessingRecovery = onCall(
  { timeoutSeconds: 120 },
  async (request) => {
    const ctx = await loadStaffContext(request);
    assertHasPermission(ctx, PERMISSIONS.VIDEOS_MANAGE);
    const result = await recoverStaleVideoProcessingJobs(ctx.uid);
    return { ok: true, ...result };
  },
);

/**
 * Admin Diagnostics: latest + recent video processing records (sanitized).
 */
export const listVideoProcessingDiagnostics = onCall(
  { timeoutSeconds: 60 },
  async (request) => {
    const ctx = await loadStaffContext(request);
    assertHasPermission(ctx, PERMISSIONS.VIDEOS_MANAGE);

    const latestSnap = await db.collection("videoProcessingDiagnosticsLatest").limit(50).get();
    const latest = latestSnap.docs
      .map((d) => d.data())
      .filter((row) => {
        if (ctx.isPlatformAdmin) return true;
        return row.companyId === ctx.companyId;
      })
      .sort((a, b) => {
        const ta = new Date(String(a.updatedAtIso || a.lastProgressAt || 0)).getTime();
        const tb = new Date(String(b.updatedAtIso || b.lastProgressAt || 0)).getTime();
        return tb - ta;
      });

    const historySnap = await db
      .collection("videoProcessingDiagnostics")
      .orderBy("createdAt", "desc")
      .limit(40)
      .get()
      .catch(async () => {
        // Fallback without composite index: recent unscoped
        return db.collection("videoProcessingDiagnostics").limit(40).get();
      });

    const history = historySnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((row) => {
        if (ctx.isPlatformAdmin) return true;
        return (row as { companyId?: string }).companyId === ctx.companyId;
      });

    return { ok: true, latest, history };
  },
);

/**
 * Check if any active sessions block video permanent deletion.
 */
async function videoHasActiveSessions(videoId: string): Promise<{
  hasActive: boolean;
  reason?: string;
  activeSessionCount?: number;
}> {
  const nowMs = Date.now();
  
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
    
    const terminalStatuses = ["completed", "closed", "revoked", "expired"];
    if (terminalStatuses.includes(status)) {
      if (!isTimeLimitedPolicy(accessPolicy)) {
        continue;
      }
    }
    
    if (isTimeLimitedPolicy(accessPolicy)) {
      if (expiresAt > nowMs) {
        activeCount++;
      }
    } else {
      if (!viewingEntitlementConsumed && !terminalStatuses.includes(status)) {
        activeCount++;
      }
    }
  }
  
  if (activeCount > 0) {
    return {
      hasActive: true,
      reason: `${activeCount} active session(s) using this video`,
      activeSessionCount: activeCount,
    };
  }
  
  return { hasActive: false };
}

/**
 * Scheduled function: Purge expired archived videos.
 * Runs every 24 hours, processes videos where:
 * - archived === true
 * - scheduledPermanentDeletionAt <= now
 * - permanentlyDeletedAt is null
 * - tombstone !== true
 */
export const purgeExpiredArchivedVideos = onSchedule(
  {
    schedule: "every 24 hours",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async () => {
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    
    logger.info("purge_expired_archived_videos_start", { timestamp: nowIso });
    
    // Query videos due for permanent deletion
    const snap = await db.collection("videos")
      .where("archived", "==", true)
      .where("scheduledPermanentDeletionAt", "<=", nowIso)
      .get();
    
    let processed = 0;
    let deleted = 0;
    let postponed = 0;
    let failed = 0;
    
    for (const doc of snap.docs) {
      const video = doc.data();
      const videoId = doc.id;
      
      // Skip if already permanently deleted or tombstone
      if (video.permanentlyDeletedAt || video.tombstone === true) {
        continue;
      }
      
      processed++;
      
      try {
        // Safety check: no active sessions / in-flight processing
        const sessionCheck = await videoHasActiveSessions(videoId);
        const processingActive = videoHasActiveProcessingJob(video);
        const blockReason = sessionCheck.hasActive
          ? sessionCheck.reason
          : processingActive
            ? "Active processing job is still running; postponing permanent deletion"
            : null;

        if (blockReason) {
          // Postpone deletion
          const postponeUntil = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
          await doc.ref.update({
            deletionPostponedUntil: postponeUntil,
            deletionPostponedReason: blockReason,
            // Cancel outstanding processing so the next cleanup run can delete safely
            ...(processingActive
              ? {
                  "processing.cancelled": true,
                  "processing.generation":
                    ((video.processing?.generation as number) ?? 0) + 1,
                }
              : {}),
            updatedAt: nowIso,
            updatedAtServer: FieldValue.serverTimestamp(),
          });

          await writeAuditEvent({
            type: AUDIT_EVENT.VIDEO_DELETION_POSTPONED,
            actorType: "system",
            payload: {
              videoId,
              companyId: video.companyId,
              reason: blockReason,
              activeSessionCount: sessionCheck.activeSessionCount ?? 0,
              processingActive,
              postponedUntil: postponeUntil,
              trigger: "scheduled_cleanup",
            },
          });

          logger.info("video_deletion_postponed", {
            videoId,
            reason: blockReason,
            activeSessionCount: sessionCheck.activeSessionCount,
            processingActive,
          });

          postponed++;
        } else {
          // Safe to delete
          await performPermanentVideoDeletion(videoId, "system:scheduled_cleanup");
          deleted++;
        }
      } catch (err) {
        logger.error("video_cleanup_failed", {
          videoId,
          error: String(err),
        });

        await writeAuditEvent({
          type: AUDIT_EVENT.VIDEO_DELETION_FAILED,
          actorType: "system",
          payload: {
            videoId,
            companyId: video.companyId,
            error: err instanceof Error ? err.message : String(err),
            trigger: "scheduled_cleanup",
          },
        });

        failed++;
      }
    }

    logger.info("purge_expired_archived_videos_complete", {
      processed,
      deleted,
      postponed,
      failed,
    });
  },
);

/**
 * Manual trigger for archived video cleanup (admin only).
 * Can also be scheduled via Cloud Scheduler HTTP if onSchedule is unavailable.
 */
export const runArchivedVideoCleanup = onCall(
  { timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const ctx = await loadStaffContext(request);
    assertHasPermission(ctx, PERMISSIONS.VIDEOS_PERMANENT_DELETE);
    
    // Optionally scope to a company
    let companyId: string | null = null;
    if (request.data?.companyId) {
      if (ctx.isPlatformAdmin) {
        companyId = String(request.data.companyId);
      } else {
        companyId = ctx.companyId || null;
      }
    }
    
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    
    logger.info("manual_archived_video_cleanup_start", {
      by: ctx.uid,
      companyId,
    });
    
    // Build query
    let query = db.collection("videos")
      .where("archived", "==", true)
      .where("scheduledPermanentDeletionAt", "<=", nowIso);
    
    if (companyId) {
      query = db.collection("videos")
        .where("companyId", "==", companyId)
        .where("archived", "==", true)
        .where("scheduledPermanentDeletionAt", "<=", nowIso);
    }
    
    const snap = await query.get();
    
    let processed = 0;
    let deleted = 0;
    let postponed = 0;
    let failed = 0;
    const deletedIds: string[] = [];
    const postponedIds: string[] = [];
    
    for (const doc of snap.docs) {
      const video = doc.data();
      const videoId = doc.id;
      
      if (video.permanentlyDeletedAt || video.tombstone === true) {
        continue;
      }
      
      // Company check for non-platform admins
      if (!ctx.isPlatformAdmin && video.companyId !== ctx.companyId) {
        continue;
      }
      
      processed++;
      
      try {
        const sessionCheck = await videoHasActiveSessions(videoId);
        const processingActive = videoHasActiveProcessingJob(video);
        const blockReason = sessionCheck.hasActive
          ? sessionCheck.reason
          : processingActive
            ? "Active processing job is still running; postponing permanent deletion"
            : null;

        if (blockReason) {
          const postponeUntil = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
          await doc.ref.update({
            deletionPostponedUntil: postponeUntil,
            deletionPostponedReason: blockReason,
            ...(processingActive
              ? {
                  "processing.cancelled": true,
                  "processing.generation":
                    ((video.processing?.generation as number) ?? 0) + 1,
                }
              : {}),
            updatedAt: nowIso,
            updatedAtServer: FieldValue.serverTimestamp(),
          });

          await writeAuditEvent({
            type: AUDIT_EVENT.VIDEO_DELETION_POSTPONED,
            actorUid: ctx.uid,
            actorType: "administrator",
            payload: {
              videoId,
              companyId: video.companyId,
              reason: blockReason,
              activeSessionCount: sessionCheck.activeSessionCount ?? 0,
              processingActive,
              postponedUntil: postponeUntil,
              trigger: "manual_cleanup",
            },
          });

          postponed++;
          postponedIds.push(videoId);
        } else {
          await performPermanentVideoDeletion(videoId, ctx.uid);
          deleted++;
          deletedIds.push(videoId);
        }
      } catch (err) {
        logger.error("manual_cleanup_video_failed", {
          videoId,
          error: String(err),
        });
        
        await writeAuditEvent({
          type: AUDIT_EVENT.VIDEO_DELETION_FAILED,
          actorUid: ctx.uid,
          actorType: "administrator",
          payload: {
            videoId,
            companyId: video.companyId,
            error: err instanceof Error ? err.message : String(err),
            trigger: "manual_cleanup",
          },
        });
        
        failed++;
      }
    }
    
    logger.info("manual_archived_video_cleanup_complete", {
      by: ctx.uid,
      processed,
      deleted,
      postponed,
      failed,
    });
    
    return {
      ok: true,
      processed,
      deleted,
      postponed,
      failed,
      deletedIds,
      postponedIds,
    };
  },
);
