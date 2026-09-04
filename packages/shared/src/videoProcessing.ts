/** Video processing pipeline status. */
export const VIDEO_PROCESSING_STATUS = {
  PENDING_UPLOAD: "pending_upload",
  UPLOADED: "uploaded",
  ANALYZING: "analyzing",
  OPTIMIZING: "optimizing",
  DETECTING_SLIDES: "detecting_slides",
  VERIFYING: "verifying",
  READY: "ready",
  FAILED: "failed",
  SKIPPED_COMPATIBLE: "skipped_compatible",
} as const;

export type VideoProcessingStatus =
  (typeof VIDEO_PROCESSING_STATUS)[keyof typeof VIDEO_PROCESSING_STATUS];

/** Archive recovery period: 30 days before permanent deletion. */
export const VIDEO_ARCHIVE_RECOVERY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Stall threshold: no meaningful FFmpeg progress (out_time advance + heartbeat)
 * for this long → Processing Failed (PROCESSING_STALLED).
 *
 * 10 minutes is intentional:
 * - Heartbeats land every ~10–15s while FFmpeg advances
 * - Brief pauses during complex scenes should not trip a short threshold
 * - Distinct from LONG PROCESSING (hours) which still heartbeats
 * - Shorter than the 3h hard ceiling so stalls fail cleanly without waiting for timeout
 */
export const VIDEO_PROCESSING_STALE_MS = 10 * 60 * 1000;

/** Hard ceiling for a single processing attempt (matches Cloud Run Job task timeout). */
export const VIDEO_PROCESSING_MAX_ATTEMPT_MS = 3 * 60 * 60 * 1000;

/** Throttle Firestore progress writes during encode. */
export const VIDEO_PROCESSING_PROGRESS_WRITE_MS = 12 * 1000;

/** Keep a bounded operational processing history (not legal evidence). */
export const VIDEO_PROCESSING_HISTORY_MAX = 10;

/** Normalized failure categories for diagnostics. */
export const VIDEO_PROCESSING_FAILURE_CATEGORY = {
  PROCESSING_STALLED: "PROCESSING_STALLED",
  PROCESSING_TIMEOUT: "PROCESSING_TIMEOUT",
  FFMPEG_FAILED: "FFMPEG_FAILED",
  FFPROBE_FAILED: "FFPROBE_FAILED",
  STORAGE_READ_FAILED: "STORAGE_READ_FAILED",
  STORAGE_WRITE_FAILED: "STORAGE_WRITE_FAILED",
  INSUFFICIENT_TEMP_STORAGE: "INSUFFICIENT_TEMP_STORAGE",
  WORKER_TERMINATED: "WORKER_TERMINATED",
  PERMISSION_ERROR: "PERMISSION_ERROR",
  UNKNOWN: "UNKNOWN",
} as const;

export type VideoProcessingFailureCategory =
  (typeof VIDEO_PROCESSING_FAILURE_CATEGORY)[keyof typeof VIDEO_PROCESSING_FAILURE_CATEGORY];

export const VIDEO_PROCESSING_IN_PROGRESS_STATUSES: readonly VideoProcessingStatus[] = [
  VIDEO_PROCESSING_STATUS.UPLOADED,
  VIDEO_PROCESSING_STATUS.ANALYZING,
  VIDEO_PROCESSING_STATUS.OPTIMIZING,
  VIDEO_PROCESSING_STATUS.DETECTING_SLIDES,
  VIDEO_PROCESSING_STATUS.VERIFYING,
] as const;

export function isVideoProcessingInProgress(
  status: VideoProcessingStatus | string | null | undefined,
): boolean {
  if (!status) return false;
  return (VIDEO_PROCESSING_IN_PROGRESS_STATUSES as readonly string[]).includes(status);
}

/**
 * Map processing status to human-readable UI label.
 */
export function videoProcessingStatusLabel(
  status: VideoProcessingStatus | string | null | undefined,
): string {
  if (!status) return "Not Analyzed";
  const labels: Record<string, string> = {
    [VIDEO_PROCESSING_STATUS.PENDING_UPLOAD]: "Not Analyzed",
    [VIDEO_PROCESSING_STATUS.UPLOADED]: "Queued",
    [VIDEO_PROCESSING_STATUS.ANALYZING]: "Analyzing",
    [VIDEO_PROCESSING_STATUS.OPTIMIZING]: "Optimizing",
    [VIDEO_PROCESSING_STATUS.DETECTING_SLIDES]: "Detecting Slides",
    [VIDEO_PROCESSING_STATUS.VERIFYING]: "Verifying",
    [VIDEO_PROCESSING_STATUS.READY]: "Ready / Optimized",
    [VIDEO_PROCESSING_STATUS.SKIPPED_COMPATIBLE]: "Ready / Already Compatible",
    [VIDEO_PROCESSING_STATUS.FAILED]: "Processing Failed",
  };
  return labels[status] || "Not Analyzed";
}

/** Target streaming profile for optimized video delivery. */
export const VIDEO_STREAMING_PROFILE = {
  container: "mp4",
  videoCodec: "h264",
  audioCodec: "aac",
  maxHeight: 1080,
  targetVideoBitrateKbps: 3500,
  fastStart: true,
} as const;

/** Result of ffprobe analysis. */
export interface VideoProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
  containerFormat: string;
  videoBitrateKbps: number | null;
  audioBitrateKbps: number | null;
  frameRate: number | null;
  hasFastStart: boolean;
}

/** Slide marker for chapter navigation. */
export interface SlideMarker {
  id: string;
  index: number;
  timeSeconds: number;
  title?: string | null;
  source: "auto" | "manual";
}

/** Lightweight operational history entry (bounded retention). */
export interface VideoProcessingHistoryEntry {
  attempt: number;
  jobId?: string | null;
  outcome: "queued" | "completed" | "failed" | "cancelled";
  status?: VideoProcessingStatus | string | null;
  failureCategory?: VideoProcessingFailureCategory | string | null;
  errorCode?: string | null;
  runtime?: string | null;
  note?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  progressPercent?: number | null;
  processedSeconds?: number | null;
  totalSeconds?: number | null;
}

/** Video processing state stored on the video document. */
export interface VideoProcessingState {
  status: VideoProcessingStatus;
  /** Alias for status used by some diagnostics UIs. */
  stage?: VideoProcessingStatus | string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  failureReason?: string | null;
  failureCategory?: VideoProcessingFailureCategory | string | null;
  probeResult?: VideoProbeResult | null;
  optimizedPath?: string | null;
  playbackPath?: string | null;
  /** Structured error code for diagnostics (e.g., VID-XXXXXX). */
  errorCode?: string | null;
  /** UID of staff who requested processing/reprocessing. */
  requestedBy?: string | null;
  /** ISO timestamp when processing was requested / queued. */
  requestedAt?: string | null;
  queuedAt?: string | null;
  /** Processing generation number for optimistic concurrency control. */
  generation?: number | null;
  /** True if processing was cancelled (e.g., video deleted during processing). */
  cancelled?: boolean | null;
  /** Cloud Run Job execution / worker id. */
  jobId?: string | null;
  /** Attempt counter for this generation. */
  attempt?: number | null;
  /** Last worker heartbeat / FFmpeg progress timestamp. */
  lastProgressAt?: string | null;
  /** Real FFmpeg progress 0–100 when duration is known; null if unknown. */
  progressPercent?: number | null;
  /** Media timestamp processed so far (seconds), from FFmpeg out_time. */
  processedSeconds?: number | null;
  /** Source/output duration used for percent/ETA (seconds). */
  totalSeconds?: number | null;
  /** Approximate remaining encode seconds when trustworthy; null otherwise. */
  estimatedRemainingSeconds?: number | null;
  /** Current stage note for diagnostics (e.g. "ffmpeg_encode"). */
  stageDetail?: string | null;
  /** Worker runtime label (e.g. cloud_run_job). */
  runtime?: string | null;
  /** Bounded operational attempt history. */
  history?: VideoProcessingHistoryEntry[] | null;
}

/** Cookie name for viewer session binding. */
export const VIEWER_SESSION_COOKIE = "spp_viewer_session";

/** OTP verification parameters. */
export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const OTP_MAX_ATTEMPTS = 5;
export const VIEWER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Threshold for restarting current slide vs going to previous. */
export const SLIDE_RESTART_THRESHOLD_SECONDS = 4;

/** Available playback speed options. */
export const PLAYBACK_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/**
 * Format seconds as M:SS or H:MM:SS for media clocks.
 */
export function formatMediaClock(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "—";
  }
  const s = Math.floor(totalSeconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/**
 * Human elapsed duration (e.g. "52 minutes").
 */
export function formatElapsedLabel(elapsedMs: number | null | undefined): string {
  if (elapsedMs == null || !Number.isFinite(elapsedMs) || elapsedMs < 0) return "—";
  const minutes = Math.floor(elapsedMs / 60000);
  const seconds = Math.floor((elapsedMs % 60000) / 1000);
  if (minutes < 1) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0
    ? `${hours} hour${hours === 1 ? "" : "s"}`
    : `${hours}h ${rem}m`;
}

/**
 * Relative "last activity" label (e.g. "8 seconds ago").
 */
export function formatLastActivityAgo(
  lastProgressAt: string | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (!lastProgressAt) return null;
  const t = new Date(lastProgressAt).getTime();
  if (!Number.isFinite(t)) return null;
  const ageSec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (ageSec < 5) return "just now";
  if (ageSec < 60) return `${ageSec} seconds ago`;
  const ageMin = Math.floor(ageSec / 60);
  if (ageMin < 120) return `${ageMin} minute${ageMin === 1 ? "" : "s"} ago`;
  return formatElapsedLabel(nowMs - t) + " ago";
}

/**
 * Approximate ETA from observed encode rate. Returns null until enough
 * trustworthy progress exists, or when the estimate would be wildly unstable.
 */
export function estimateRemainingSeconds(input: {
  processedSeconds: number;
  totalSeconds: number;
  encodeElapsedSeconds: number;
}): number | null {
  const { processedSeconds, totalSeconds, encodeElapsedSeconds } = input;
  if (
    !Number.isFinite(processedSeconds) ||
    !Number.isFinite(totalSeconds) ||
    !Number.isFinite(encodeElapsedSeconds)
  ) {
    return null;
  }
  if (totalSeconds <= 0 || processedSeconds <= 0) return null;
  if (encodeElapsedSeconds < 60) return null;
  if (processedSeconds < 30) return null;
  const pct = processedSeconds / totalSeconds;
  if (pct < 0.05 || pct > 0.97) return null;

  const rate = processedSeconds / encodeElapsedSeconds; // media-sec per wall-sec
  if (!Number.isFinite(rate) || rate < 0.02 || rate > 8) return null;

  const remainingMedia = Math.max(0, totalSeconds - processedSeconds);
  const eta = remainingMedia / rate;
  if (!Number.isFinite(eta) || eta < 15 || eta > VIDEO_PROCESSING_MAX_ATTEMPT_MS / 1000) {
    return null;
  }
  return Math.round(eta);
}

/**
 * Append a history entry and trim to retention limit (newest last).
 */
export function appendProcessingHistory(
  existing: VideoProcessingHistoryEntry[] | null | undefined,
  entry: VideoProcessingHistoryEntry,
  max: number = VIDEO_PROCESSING_HISTORY_MAX,
): VideoProcessingHistoryEntry[] {
  const next = [...(Array.isArray(existing) ? existing : []), entry];
  if (next.length <= max) return next;
  return next.slice(next.length - max);
}

/**
 * Classify abandonment: hard timeout vs heartbeat stall.
 */
export function classifyProcessingAbandonment(input: {
  startedAt?: string | null;
  queuedAt?: string | null;
  requestedAt?: string | null;
  lastProgressAt?: string | null;
  nowMs?: number;
  staleMs?: number;
  maxAttemptMs?: number;
}): VideoProcessingFailureCategory {
  const nowMs = input.nowMs ?? Date.now();
  const staleMs = input.staleMs ?? VIDEO_PROCESSING_STALE_MS;
  const maxAttemptMs = input.maxAttemptMs ?? VIDEO_PROCESSING_MAX_ATTEMPT_MS;
  const started =
    input.startedAt || input.queuedAt || input.requestedAt || input.lastProgressAt;
  if (started) {
    const startedMs = new Date(started).getTime();
    if (Number.isFinite(startedMs) && nowMs - startedMs > maxAttemptMs) {
      return VIDEO_PROCESSING_FAILURE_CATEGORY.PROCESSING_TIMEOUT;
    }
  }
  const last =
    input.lastProgressAt || input.startedAt || input.queuedAt || input.requestedAt;
  if (last) {
    const lastMs = new Date(last).getTime();
    if (Number.isFinite(lastMs) && nowMs - lastMs > staleMs) {
      return VIDEO_PROCESSING_FAILURE_CATEGORY.PROCESSING_STALLED;
    }
  }
  return VIDEO_PROCESSING_FAILURE_CATEGORY.WORKER_TERMINATED;
}

/**
 * Mask email for privacy display.
 * Example: john.doe@example.com → j***e@e***.com
 */
export function maskEmail(email: string): string {
  if (!email || !email.includes("@")) return "***@***.***";
  const [localPart, domain] = email.split("@");
  if (!localPart || !domain) return "***@***.***";

  const maskPart = (s: string, keepFirst: number, keepLast: number): string => {
    if (s.length <= keepFirst + keepLast) {
      return s.length <= 2 ? "*".repeat(s.length) : s[0] + "*".repeat(s.length - 1);
    }
    return s.slice(0, keepFirst) + "***" + s.slice(-keepLast);
  };

  const domainParts = domain.split(".");
  const tld = domainParts.length > 1 ? domainParts.pop() : "";
  const domainName = domainParts.join(".");

  const maskedLocal = maskPart(localPart, 1, 1);
  const maskedDomain = maskPart(domainName, 1, 0);

  return `${maskedLocal}@${maskedDomain}${tld ? "." + tld : ""}`;
}
