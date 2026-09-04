/**
 * Pure, testable functions for video lifecycle logic.
 * No Firebase dependencies — designed for unit testing.
 */

import {
  VIDEO_PROCESSING_STATUS,
  VIDEO_ARCHIVE_RECOVERY_MS,
  VIDEO_PROCESSING_STALE_MS,
  VIDEO_PROCESSING_MAX_ATTEMPT_MS,
  isTimeLimitedPolicy,
  isVideoProcessingInProgress,
  type VideoProcessingStatus,
  type AccessPolicy,
} from "../shared";

/**
 * Compute scheduled permanent deletion timestamp from archive time.
 */
export function computeScheduledDeletionAt(
  archivedAtIso: string,
  recoveryMs: number = VIDEO_ARCHIVE_RECOVERY_MS,
): string {
  const archivedAt = new Date(archivedAtIso).getTime();
  return new Date(archivedAt + recoveryMs).toISOString();
}

/**
 * Calculate days remaining until scheduled deletion.
 * Returns null if no scheduled deletion or invalid date.
 * Returns 0 if already past scheduled time.
 */
export function daysRemainingUntilDeletion(
  scheduledIso: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!scheduledIso) return null;
  const scheduled = new Date(scheduledIso).getTime();
  if (!Number.isFinite(scheduled)) return null;
  if (scheduled <= nowMs) return 0;
  return Math.ceil((scheduled - nowMs) / (24 * 60 * 60 * 1000));
}

/**
 * Minimal session shape for deletion blocking check.
 */
export interface SessionForDeletionCheck {
  status: string;
  accessPolicy?: AccessPolicy | null;
  expiresAt?: string | null;
  viewingEntitlementConsumed?: boolean;
}

const TERMINAL_SESSION_STATUSES = ["completed", "closed", "revoked", "expired"];

/**
 * Check if a session blocks video deletion (pure function).
 * 
 * For time-limited: blocks if expiresAt > nowMs
 * For single-view: blocks if not consumed AND status is not terminal
 */
export function sessionBlocksVideoDeletion(
  session: SessionForDeletionCheck,
  nowMs: number = Date.now(),
): boolean {
  const status = session.status;
  const expiresAt = session.expiresAt ? new Date(session.expiresAt).getTime() : 0;
  const isTerminal = TERMINAL_SESSION_STATUSES.includes(status);
  
  if (isTimeLimitedPolicy(session.accessPolicy)) {
    // Time-limited: terminal status doesn't matter, only expiration
    return expiresAt > nowMs;
  } else {
    // Single-view: blocks if not consumed and not terminal
    if (session.viewingEntitlementConsumed === true) {
      return false;
    }
    return !isTerminal;
  }
}

/**
 * True when an in-progress processing job has gone silent long enough to mark failed,
 * or the absolute attempt ceiling was exceeded.
 *
 * LONG PROCESSING (hours of FFmpeg with regular heartbeats) is NOT stale.
 * STUCK PROCESSING (no heartbeat / no FFmpeg out_time advance for staleMs) IS stale.
 */
export function isVideoProcessingStale(
  processing: {
    status?: VideoProcessingStatus | string | null;
    cancelled?: boolean | null;
    lastProgressAt?: string | null;
    startedAt?: string | null;
    queuedAt?: string | null;
    requestedAt?: string | null;
  } | null | undefined,
  nowMs: number = Date.now(),
  staleMs: number = VIDEO_PROCESSING_STALE_MS,
  maxAttemptMs: number = VIDEO_PROCESSING_MAX_ATTEMPT_MS,
): boolean {
  if (!processing || processing.cancelled === true) return false;
  if (!isVideoProcessingInProgress(processing.status)) return false;

  const last =
    processing.lastProgressAt ||
    processing.startedAt ||
    processing.queuedAt ||
    processing.requestedAt;
  if (!last) return true;
  const lastMs = new Date(last).getTime();
  if (!Number.isFinite(lastMs)) return true;

  const started =
    processing.startedAt ||
    processing.queuedAt ||
    processing.requestedAt ||
    last;
  const startedMs = new Date(started).getTime();
  if (Number.isFinite(startedMs) && nowMs - startedMs > maxAttemptMs) {
    return true;
  }
  return nowMs - lastMs > staleMs;
}

/**
 * Minimal video shape for optimization queue check.
 */
export interface VideoForOptimizationCheck {
  storagePath?: string | null;
  deleted?: boolean;
  tombstone?: boolean;
  permanentlyDeletedAt?: string | null;
  archived?: boolean;
  status?: string;
  processing?: {
    status?: VideoProcessingStatus | string;
    cancelled?: boolean | null;
  } | null;
}

const ACTIVE_PROCESSING_STATUSES = new Set<string>([
  VIDEO_PROCESSING_STATUS.UPLOADED,
  VIDEO_PROCESSING_STATUS.ANALYZING,
  VIDEO_PROCESSING_STATUS.OPTIMIZING,
  VIDEO_PROCESSING_STATUS.DETECTING_SLIDES,
  VIDEO_PROCESSING_STATUS.VERIFYING,
]);

/**
 * True when a processing job is still in flight and has not been cancelled.
 * Used to postpone permanent deletion until the worker can be superseded safely.
 */
export function videoHasActiveProcessingJob(video: {
  processing?: {
    status?: VideoProcessingStatus | string | null;
    cancelled?: boolean | null;
  } | null;
}): boolean {
  if (video.processing?.cancelled === true) return false;
  const status = video.processing?.status;
  if (!status) return false;
  return ACTIVE_PROCESSING_STATUSES.has(status);
}

/**
 * Check if a video needs to be queued for optimization (pure function).
 * 
 * Returns true if:
 * - Has storagePath
 * - Not deleted/tombstone/archived
 * - Processing missing OR status failed OR never ready/skipped
 * 
 * Note: Queue operation only touches video.processing fields,
 * never session accessPolicy/expiresAt/viewerAuth fields.
 */
export function videoNeedsOptimizationQueue(video: VideoForOptimizationCheck): boolean {
  // Must have storagePath
  if (!video.storagePath) return false;
  
  // Must not be deleted/tombstone/archived
  if (video.deleted === true) return false;
  if (video.tombstone === true) return false;
  if (video.permanentlyDeletedAt) return false;
  if (video.archived === true) return false;
  if (video.status === "archived") return false;
  
  // Check processing state
  const status = video.processing?.status;
  if (!status) return true; // No processing state - needs optimization
  if (status === VIDEO_PROCESSING_STATUS.FAILED) return true; // Failed - retry
  if (status === VIDEO_PROCESSING_STATUS.READY) return false; // Already ready
  if (status === VIDEO_PROCESSING_STATUS.SKIPPED_COMPATIBLE) return false; // Already compatible
  
  // Other states (analyzing, optimizing, etc.) - don't re-queue
  return false;
}
