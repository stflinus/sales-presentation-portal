/**
 * Sanitized video-processing diagnostics for Admin Diagnostics.
 * Never logs signed URLs, tokens, cookies, OTP, or auth headers.
 */

import { FieldValue } from "firebase-admin/firestore";
import type {
  VideoProcessingFailureCategory,
  VideoProcessingHistoryEntry,
} from "../shared";
import {
  VIDEO_PROCESSING_HISTORY_MAX,
  appendProcessingHistory,
} from "../shared";
import { db } from "./firebase";

const SECRETISH =
  /(https?:\/\/\S+)|(Bearer\s+\S+)|(cookie\s*[:=]\S+)|(otp\s*[:=]\S+)|(authorization\s*[:=]\S+)/gi;

export function sanitizeProcessingErrorText(input: unknown, max = 800): string {
  const raw = input instanceof Error ? input.message : String(input ?? "");
  return raw.replace(SECRETISH, "[redacted]").slice(0, max);
}

export function classifyFfmpegFailure(err: unknown): VideoProcessingFailureCategory {
  const msg = sanitizeProcessingErrorText(err, 2000).toLowerCase();
  if (msg.includes("processing_stalled") || msg.includes("no meaningful progress")) {
    return "PROCESSING_STALLED";
  }
  if (msg.includes("processing_timeout") || msg.includes("hard timeout")) {
    return "PROCESSING_TIMEOUT";
  }
  if (msg.includes("enospc") || msg.includes("no space") || msg.includes("disk quota")) {
    return "INSUFFICIENT_TEMP_STORAGE";
  }
  if (msg.includes("permission") || msg.includes("403") || msg.includes("forbidden")) {
    return "PERMISSION_ERROR";
  }
  if (msg.includes("ffprobe") || msg.includes("probe")) {
    return "FFPROBE_FAILED";
  }
  if (
    msg.includes("storage") ||
    msg.includes("download") ||
    msg.includes("enoent") && msg.includes("download")
  ) {
    return "STORAGE_READ_FAILED";
  }
  if (msg.includes("upload") || msg.includes("staging") || msg.includes("copy")) {
    return "STORAGE_WRITE_FAILED";
  }
  if (msg.includes("sigkill") || msg.includes("sigterm") || msg.includes("worker")) {
    return "WORKER_TERMINATED";
  }
  if (msg.includes("ffmpeg") || msg.includes("command failed") || msg.includes("libx264")) {
    return "FFMPEG_FAILED";
  }
  return "UNKNOWN";
}

export interface VideoProcessingDiagnosticRecord {
  videoId: string;
  title?: string | null;
  jobId?: string | null;
  attempt?: number | null;
  stage?: string | null;
  status?: string | null;
  startedAt?: string | null;
  lastProgressAt?: string | null;
  elapsedMs?: number | null;
  progressPercent?: number | null;
  processedSeconds?: number | null;
  totalSeconds?: number | null;
  sourceDurationSeconds?: number | null;
  runtime?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  terminationReason?: string | null;
  ffmpegErrorSummary?: string | null;
  failureCategory?: VideoProcessingFailureCategory | string | null;
  errorCode?: string | null;
  companyId?: string | null;
  outcome: "progress" | "failed" | "completed";
}

export async function writeVideoProcessingDiagnostic(
  record: VideoProcessingDiagnosticRecord,
  opts?: { persistHistory?: boolean },
): Promise<void> {
  try {
    const persistHistory = opts?.persistHistory ?? record.outcome !== "progress";

    // Upsert latest snapshot for Admin Diagnostics by videoId.
    await db.collection("videoProcessingDiagnosticsLatest").doc(record.videoId).set(
      {
        videoId: record.videoId,
        title: record.title ?? null,
        jobId: record.jobId ?? null,
        attempt: record.attempt ?? null,
        stage: record.stage ?? null,
        status: record.status ?? null,
        startedAt: record.startedAt ?? null,
        lastProgressAt: record.lastProgressAt ?? null,
        elapsedMs: record.elapsedMs ?? null,
        progressPercent: record.progressPercent ?? null,
        processedSeconds: record.processedSeconds ?? null,
        totalSeconds: record.totalSeconds ?? null,
        sourceDurationSeconds: record.sourceDurationSeconds ?? null,
        runtime: record.runtime ?? null,
        exitCode: record.exitCode ?? null,
        signal: record.signal ?? null,
        terminationReason: record.terminationReason ?? null,
        ffmpegErrorSummary: record.ffmpegErrorSummary
          ? sanitizeProcessingErrorText(record.ffmpegErrorSummary)
          : null,
        failureCategory: record.failureCategory ?? null,
        errorCode: record.errorCode ?? null,
        companyId: record.companyId ?? null,
        outcome: record.outcome,
        updatedAt: FieldValue.serverTimestamp(),
        updatedAtIso: new Date().toISOString(),
      },
      { merge: true },
    );

    if (persistHistory) {
      const ref = db.collection("videoProcessingDiagnostics").doc();
      await ref.set({
        id: ref.id,
        ...record,
        ffmpegErrorSummary: record.ffmpegErrorSummary
          ? sanitizeProcessingErrorText(record.ffmpegErrorSummary)
          : null,
        createdAt: FieldValue.serverTimestamp(),
        createdAtIso: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error("write_video_processing_diagnostic_failed", String(err));
  }
}

export function mergeHistoryOnVideo(
  existing: VideoProcessingHistoryEntry[] | null | undefined,
  entry: VideoProcessingHistoryEntry,
): VideoProcessingHistoryEntry[] {
  return appendProcessingHistory(existing, entry, VIDEO_PROCESSING_HISTORY_MAX);
}
