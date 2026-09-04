import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  AUDIT_EVENT,
  PERMISSIONS,
  VIDEO_PROCESSING_STATUS,
  VIDEO_PROCESSING_STALE_MS,
  VIDEO_PROCESSING_PROGRESS_WRITE_MS,
  VIDEO_PROCESSING_FAILURE_CATEGORY,
  VIDEO_STREAMING_PROFILE,
  VIDEO_STATUS,
  appendProcessingHistory,
  estimateRemainingSeconds,
  isVideoProcessingInProgress,
  type VideoProbeResult,
  type SlideMarker,
  type VideoProcessingHistoryEntry,
} from "../shared";
import { assertHasPermission, loadStaffContext, resolveActingCompanyId } from "../lib/authz";
import { writeAuditEvent } from "../lib/audit";
import { bucket, db } from "../lib/firebase";
import { evaluateStreamingProfile, filterSlideTimestamps, buildSlideMarkers } from "../lib/videoProbe.pure";
import { getPortalSettings } from "../lib/settings";
import { dispatchVideoProcessJob } from "../lib/dispatchVideoProcessJob";
import {
  classifyFfmpegFailure,
  mergeHistoryOnVideo,
  sanitizeProcessingErrorText,
  writeVideoProcessingDiagnostic,
} from "../lib/videoProcessingDiagnostics";

const WORKER_RUNTIME = "cloud_run_job";

export class ProcessingStallError extends Error {
  readonly failureCategory = VIDEO_PROCESSING_FAILURE_CATEGORY.PROCESSING_STALLED;
  readonly exitCode: number | null;
  readonly signal: string | null;
  constructor(message: string, exitCode: number | null = null, signal: string | null = "SIGKILL") {
    super(message);
    this.name = "ProcessingStallError";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

/** Resolve ffmpeg/ffprobe paths (Cloud Run Job uses system binaries). */
function getFfmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return require("@ffmpeg-installer/ffmpeg").path;
  } catch {
    return "/usr/bin/ffmpeg";
  }
}

function getFfprobePath(): string {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  try {
    return require("@ffprobe-installer/ffprobe").path;
  } catch {
    return "/usr/bin/ffprobe";
  }
}

/** Run a command and return stdout/stderr. */
async function runCommand(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const detail = (stderr || stdout || "").slice(-2000);
        reject(new Error(`Command failed with code ${code}: ${detail}`));
      }
    });
    proc.on("error", reject);
  });
}

/** Probe video with ffprobe */
async function probeVideo(inputPath: string): Promise<VideoProbeResult> {
  const ffprobe = getFfprobePath();
  const { stdout } = await runCommand(ffprobe, [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    inputPath,
  ]);

  const data = JSON.parse(stdout);
  const videoStream = data.streams?.find((s: { codec_type: string }) => s.codec_type === "video");
  const audioStream = data.streams?.find((s: { codec_type: string }) => s.codec_type === "audio");
  const format = data.format || {};

  const durationSeconds = parseFloat(
    format.duration ||
      videoStream?.duration ||
      audioStream?.duration ||
      "0",
  );
  // Some WebM/Matroska files report bogus r_frame_rate like "1000/1". Prefer avg_frame_rate.
  const frameRateStr =
    videoStream?.avg_frame_rate && videoStream.avg_frame_rate !== "0/0"
      ? videoStream.avg_frame_rate
      : videoStream?.r_frame_rate || "0/1";
  const [num, den] = frameRateStr.split("/").map((n: string) => parseInt(n, 10));
  let frameRate = den > 0 ? num / den : null;
  if (frameRate != null && (frameRate > 120 || frameRate <= 0)) {
    frameRate = null;
  }

  const width = parseInt(videoStream?.width || "0", 10);
  const height = parseInt(videoStream?.height || "0", 10);
  const videoCodec = videoStream?.codec_name || "unknown";
  const audioCodec = audioStream?.codec_name || null;
  const containerFormat = format.format_name || "unknown";
  const videoBitrateKbps = videoStream?.bit_rate
    ? Math.round(parseInt(videoStream.bit_rate, 10) / 1000)
    : format.bit_rate
      ? Math.round(parseInt(format.bit_rate, 10) / 1000)
      : null;
  const audioBitrateKbps = audioStream?.bit_rate
    ? Math.round(parseInt(audioStream.bit_rate, 10) / 1000)
    : null;

  // Check for faststart (moov atom position)
  let hasFastStart = false;
  try {
    const { stdout: atomsOutput } = await runCommand(ffprobe, [
      "-v", "quiet",
      "-show_entries", "format_tags=major_brand",
      "-print_format", "json",
      inputPath,
    ]);
    const atomsData = JSON.parse(atomsOutput);
    // If we can read the file quickly, it likely has faststart
    // A more precise check would require parsing atom positions
    hasFastStart = Boolean(atomsData.format?.tags?.major_brand);
  } catch {
    hasFastStart = false;
  }

  // Prefer container duration; fall back to decoding duration via ffprobe -count_frames is too slow.
  // For WebM without format.duration, ask ffprobe for stream duration explicitly.
  let resolvedDuration = durationSeconds;
  if (!Number.isFinite(resolvedDuration) || resolvedDuration <= 0) {
    try {
      const { stdout: durOut } = await runCommand(ffprobe, [
        "-v", "error",
        "-show_entries", "format=duration:stream=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        inputPath,
      ]);
      for (const line of durOut.split("\n")) {
        const n = parseFloat(line.trim());
        if (Number.isFinite(n) && n > 0) {
          resolvedDuration = n;
          break;
        }
      }
    } catch {
      /* keep 0 */
    }
  }

  // Last resort: ffmpeg -i banner Duration: HH:MM:SS.xx (works when format.duration is N/A).
  if (!Number.isFinite(resolvedDuration) || resolvedDuration <= 0) {
    try {
      const ffmpeg = getFfmpegPath();
      const banner = await new Promise<string>((resolve) => {
        const proc = spawn(ffmpeg, ["-hide_banner", "-i", inputPath]);
        let stderr = "";
        proc.stderr.on("data", (d) => {
          stderr += d.toString();
        });
        proc.on("close", () => resolve(stderr));
        proc.on("error", () => resolve(stderr));
      });
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i.exec(banner);
      if (m) {
        const h = parseInt(m[1], 10);
        const min = parseInt(m[2], 10);
        const sec = parseFloat(m[3]);
        const total = h * 3600 + min * 60 + sec;
        if (Number.isFinite(total) && total > 0) resolvedDuration = total;
      }
    } catch {
      /* keep 0 */
    }
  }

  return {
    durationSeconds: Number.isFinite(resolvedDuration) ? resolvedDuration : 0,
    width,
    height,
    videoCodec,
    audioCodec,
    containerFormat,
    videoBitrateKbps,
    audioBitrateKbps,
    frameRate,
    hasFastStart,
  };
}

export type FfmpegProgressInfo = {
  percent: number | null;
  processedSeconds: number;
  totalSeconds: number | null;
  detail: string;
};

/** Optimize video to H.264/AAC MP4 with faststart; reports real FFmpeg progress. */
async function optimizeVideo(
  inputPath: string,
  outputPath: string,
  probe: VideoProbeResult,
  onProgress?: (info: FfmpegProgressInfo) => Promise<void>,
  shouldAbort?: () => Promise<boolean>,
): Promise<void> {
  const ffmpeg = getFfmpegPath();
  const profile = VIDEO_STREAMING_PROFILE;
  const totalSeconds = probe.durationSeconds > 0 ? probe.durationSeconds : null;
  const durationMs = totalSeconds != null ? totalSeconds * 1000 : null;

  // veryfast: production evidence showed medium+540s CF timeout killed overnight jobs.
  const args = [
    "-y",
    "-i", inputPath,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-threads", "0",
    "-crf", "23",
    "-maxrate", `${profile.targetVideoBitrateKbps}k`,
    "-bufsize", `${profile.targetVideoBitrateKbps * 2}k`,
    "-vf", `scale=-2:'min(${profile.maxHeight},ih)'`,
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    "-progress", "pipe:1",
    "-nostats",
    outputPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, args);
    let stderr = "";
    let lastEmit = 0;
    let lastPercentEmitted: number | null = null;
    let stdoutBuf = "";
    let lastOutTimeMs = -1;
    let lastAdvanceAt = Date.now();
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      fn();
    };

    const killProc = (signal: NodeJS.Signals = "SIGKILL") => {
      try {
        proc.kill(signal);
      } catch {
        /* ignore */
      }
    };

    const maybeEmit = async (outTimeMs: number) => {
      if (outTimeMs > lastOutTimeMs) {
        lastOutTimeMs = outTimeMs;
        lastAdvanceAt = Date.now();
      }
      const now = Date.now();
      const processedSeconds = Math.max(0, outTimeMs / 1000);
      let percent: number | null = null;
      if (durationMs && durationMs > 0) {
        percent = Math.max(0, Math.min(99, Math.round((outTimeMs / durationMs) * 100)));
      }
      const percentAdvanced =
        percent != null &&
        (lastPercentEmitted == null || percent - lastPercentEmitted >= 1);
      if (now - lastEmit < VIDEO_PROCESSING_PROGRESS_WRITE_MS && !percentAdvanced) {
        return;
      }
      lastEmit = now;
      if (percent != null) lastPercentEmitted = percent;
      if (onProgress) {
        try {
          await onProgress({
            percent,
            processedSeconds,
            totalSeconds,
            detail: "ffmpeg_encode",
          });
        } catch {
          /* ignore heartbeat errors mid-encode */
        }
      }
      if (shouldAbort) {
        try {
          if (await shouldAbort()) {
            killProc("SIGTERM");
            setTimeout(() => killProc("SIGKILL"), 2000);
            finish(() =>
              reject(new Error("Processing cancelled (generation superseded or cancelled).")),
            );
          }
        } catch {
          /* ignore */
        }
      }
    };

    const watchdog = setInterval(() => {
      if (settled) return;
      const silentMs = Date.now() - lastAdvanceAt;
      if (silentMs >= VIDEO_PROCESSING_STALE_MS) {
        killProc("SIGKILL");
        finish(() =>
          reject(
            new ProcessingStallError(
              `PROCESSING_STALLED: no meaningful FFmpeg progress for ${Math.round(silentMs / 60000)} minutes (threshold ${VIDEO_PROCESSING_STALE_MS / 60000}m).`,
            ),
          ),
        );
      }
    }, 30_000);

    proc.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("out_time_ms=")) {
          const ms = Number(line.slice("out_time_ms=".length));
          if (Number.isFinite(ms) && ms >= 0) void maybeEmit(ms);
        } else if (line.startsWith("out_time=")) {
          // out_time=HH:MM:SS.microseconds fallback
          const raw = line.slice("out_time=".length).trim();
          const parts = raw.split(":");
          if (parts.length === 3) {
            const h = parseFloat(parts[0]);
            const m = parseFloat(parts[1]);
            const s = parseFloat(parts[2]);
            if ([h, m, s].every(Number.isFinite)) {
              void maybeEmit(Math.round((h * 3600 + m * 60 + s) * 1000));
            }
          }
        }
      }
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
      if (stderr.length > 50000) stderr = stderr.slice(-30000);
    });
    proc.on("close", (code, signal) => {
      if (settled) return;
      if (code === 0) {
        finish(() => resolve());
      } else {
        const detail = sanitizeProcessingErrorText(stderr.slice(-2000));
        finish(() =>
          reject(
            Object.assign(
              new Error(`Command failed with code ${code}${signal ? ` signal ${signal}` : ""}: ${detail}`),
              { exitCode: code, signal: signal || null },
            ),
          ),
        );
      }
    });
    proc.on("error", (err) => {
      finish(() => reject(err));
    });
  });
}

/** Detect slide changes using scene detection */
async function detectSlideChanges(
  inputPath: string,
  durationSeconds: number,
): Promise<number[]> {
  const ffmpeg = getFfmpegPath();
  const timestamps: number[] = [];

  try {
    // Use scene detection filter
    const { stderr } = await runCommand(ffmpeg, [
      "-i", inputPath,
      "-vf", "select='gt(scene,0.3)',showinfo",
      "-f", "null",
      "-",
    ]);

    // Parse scene change timestamps from stderr
    const regex = /pts_time:(\d+\.?\d*)/g;
    let match;
    while ((match = regex.exec(stderr)) !== null) {
      const time = parseFloat(match[1]);
      if (Number.isFinite(time) && time > 0) {
        timestamps.push(time);
      }
    }
  } catch (err) {
    logger.warn("slide_detection_failed", { error: String(err) });
  }

  return filterSlideTimestamps(timestamps, durationSeconds);
}

/** Generate a structured error code for diagnostics. */
function generateErrorCode(): string {
  const hex = Math.random().toString(16).slice(2, 8).toUpperCase().padEnd(6, "0");
  return `VID-${hex}`;
}

/**
 * Process a single video document.
 * Non-destructive: never clears playbackStoragePath on failure.
 * Uses generation number for optimistic concurrency control.
 */
export async function processVideoDocument(
  videoId: string,
  opts?: { expectedGeneration?: number; jobId?: string | null },
): Promise<void> {
  const videoRef = db.collection("videos").doc(videoId);
  const videoSnap = await videoRef.get();

  if (!videoSnap.exists) {
    throw new Error(`Video ${videoId} not found`);
  }

  const video = videoSnap.data()!;
  const storagePath = String(video.storagePath || "");

  // Abort if video is deleted, tombstone, or cancelled
  if (video.deleted === true || video.tombstone === true) {
    logger.info("video_process_abort_deleted", { videoId });
    return;
  }
  if (video.processing?.cancelled === true) {
    logger.info("video_process_abort_cancelled", { videoId });
    return;
  }

  if (!storagePath) {
    throw new Error(`Video ${videoId} has no storage path`);
  }

  // Capture generation at start for race protection
  const startGeneration = video.processing?.generation ?? 0;
  if (
    opts?.expectedGeneration != null &&
    opts.expectedGeneration !== startGeneration
  ) {
    logger.info("video_process_abort_generation_mismatch", {
      videoId,
      expectedGeneration: opts.expectedGeneration,
      startGeneration,
    });
    return;
  }

  const nowIso = () => new Date().toISOString();
  const jobId = opts?.jobId || video.processing?.jobId || null;
  const attempt = (video.processing?.attempt as number) ?? 1;
  const encodeStartedAtMs = { current: Date.now() };
  const progressState = {
    processedSeconds: null as number | null,
    totalSeconds: null as number | null,
    progressPercent: null as number | null,
    estimatedRemainingSeconds: null as number | null,
  };
  const tmpDir = os.tmpdir();
  const inputFile = path.join(tmpDir, `video_${videoId}_input`);
  // Use generation-specific staging path
  const stagingOutputPath = `videos/${videoId}/optimized.gen${startGeneration}.mp4`;
  const outputFile = path.join(tmpDir, `video_${videoId}_output.mp4`);

  async function heartbeat(
    stageDetail: string,
    progress?: {
      percent?: number | null;
      processedSeconds?: number | null;
      totalSeconds?: number | null;
    },
  ): Promise<void> {
    const iso = nowIso();
    if (progress?.processedSeconds != null) {
      progressState.processedSeconds = progress.processedSeconds;
    }
    if (progress?.totalSeconds != null) {
      progressState.totalSeconds = progress.totalSeconds;
    }
    if (progress?.percent !== undefined) {
      progressState.progressPercent = progress.percent;
    }

    let eta: number | null = null;
    if (
      progressState.processedSeconds != null &&
      progressState.totalSeconds != null &&
      progressState.totalSeconds > 0
    ) {
      eta = estimateRemainingSeconds({
        processedSeconds: progressState.processedSeconds,
        totalSeconds: progressState.totalSeconds,
        encodeElapsedSeconds: (Date.now() - encodeStartedAtMs.current) / 1000,
      });
      progressState.estimatedRemainingSeconds = eta;
    }

    const startedAt =
      (video.processing?.startedAt as string | undefined) ||
      iso;
    const elapsedMs = Date.now() - new Date(startedAt).getTime();

    await videoRef.update({
      "processing.lastProgressAt": iso,
      "processing.stageDetail": stageDetail,
      "processing.runtime": WORKER_RUNTIME,
      ...(progress?.percent !== undefined
        ? { "processing.progressPercent": progress.percent }
        : {}),
      ...(progress?.processedSeconds != null
        ? { "processing.processedSeconds": progress.processedSeconds }
        : {}),
      ...(progress?.totalSeconds != null
        ? { "processing.totalSeconds": progress.totalSeconds }
        : {}),
      "processing.estimatedRemainingSeconds": eta,
      updatedAt: iso,
      updatedAtServer: FieldValue.serverTimestamp(),
    });

    // Lightweight live diagnostics snapshot (throttled with caller).
    if (stageDetail === "ffmpeg_encode") {
      await writeVideoProcessingDiagnostic({
        videoId,
        title: String(video.title || ""),
        jobId,
        attempt,
        stage: stageDetail,
        status: VIDEO_PROCESSING_STATUS.OPTIMIZING,
        startedAt: video.processing?.startedAt || iso,
        lastProgressAt: iso,
        elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
        progressPercent: progressState.progressPercent,
        processedSeconds: progressState.processedSeconds,
        totalSeconds: progressState.totalSeconds,
        sourceDurationSeconds: progressState.totalSeconds,
        runtime: WORKER_RUNTIME,
        outcome: "progress",
        companyId: video.companyId ?? null,
      });
    }
  }

  /** Check if processing should continue (race protection). */
  async function shouldContinue(): Promise<boolean> {
    const freshSnap = await videoRef.get();
    if (!freshSnap.exists) return false;
    const fresh = freshSnap.data()!;
    if (fresh.deleted === true || fresh.tombstone === true) return false;
    if (fresh.processing?.cancelled === true) return false;
    const currentGen = fresh.processing?.generation ?? 0;
    if (currentGen !== startGeneration) {
      logger.info("video_process_abort_generation_changed", {
        videoId,
        startGeneration,
        currentGeneration: currentGen,
      });
      return false;
    }
    return true;
  }

  try {
    // Update status to analyzing
    await videoRef.update({
      "processing.status": VIDEO_PROCESSING_STATUS.ANALYZING,
      "processing.stage": VIDEO_PROCESSING_STATUS.ANALYZING,
      "processing.startedAt": nowIso(),
      "processing.lastProgressAt": nowIso(),
      "processing.stageDetail": "download_source",
      "processing.progressPercent": null,
      "processing.processedSeconds": null,
      "processing.totalSeconds": null,
      "processing.estimatedRemainingSeconds": null,
      "processing.runtime": WORKER_RUNTIME,
      "processing.failureCategory": null,
      ...(jobId ? { "processing.jobId": jobId } : {}),
      updatedAt: nowIso(),
      updatedAtServer: FieldValue.serverTimestamp(),
    });

    // Download video from Storage
    logger.info("video_process_download", { videoId, storagePath, jobId });
    try {
      const file = bucket.file(storagePath);
      await file.download({ destination: inputFile });
    } catch (dlErr) {
      const wrapped = Object.assign(
        new Error(`STORAGE_READ_FAILED: ${sanitizeProcessingErrorText(dlErr)}`),
        { failureCategory: VIDEO_PROCESSING_FAILURE_CATEGORY.STORAGE_READ_FAILED },
      );
      throw wrapped;
    }
    await heartbeat("probe");

    // Check race before continuing
    if (!(await shouldContinue())) return;

    // Probe video
    logger.info("video_process_probe", { videoId });
    let probe: VideoProbeResult;
    try {
      probe = await probeVideo(inputFile);
    } catch (probeErr) {
      throw Object.assign(
        new Error(`FFPROBE_FAILED: ${sanitizeProcessingErrorText(probeErr)}`),
        { failureCategory: VIDEO_PROCESSING_FAILURE_CATEGORY.FFPROBE_FAILED },
      );
    }
    const evaluation = evaluateStreamingProfile(probe);

    logger.info("video_process_evaluation", {
      videoId,
      needsOptimization: evaluation.needsOptimization,
      reasons: evaluation.reasons,
      durationSeconds: probe.durationSeconds,
    });
    await heartbeat("evaluated", {
      totalSeconds: probe.durationSeconds > 0 ? probe.durationSeconds : null,
    });

    let finalPlaybackPath = storagePath;
    let finalOptimizedPath: string | null = null;

    if (evaluation.needsOptimization) {
      // Update status to optimizing
      encodeStartedAtMs.current = Date.now();
      progressState.totalSeconds = probe.durationSeconds > 0 ? probe.durationSeconds : null;
      await videoRef.update({
        "processing.status": VIDEO_PROCESSING_STATUS.OPTIMIZING,
        "processing.stage": VIDEO_PROCESSING_STATUS.OPTIMIZING,
        "processing.probeResult": probe,
        "processing.lastProgressAt": nowIso(),
        "processing.stageDetail": "ffmpeg_encode",
        "processing.progressPercent": probe.durationSeconds > 0 ? 0 : null,
        "processing.processedSeconds": 0,
        "processing.totalSeconds": progressState.totalSeconds,
        "processing.estimatedRemainingSeconds": null,
        updatedAt: nowIso(),
        updatedAtServer: FieldValue.serverTimestamp(),
      });

      // Check race before heavy operation
      if (!(await shouldContinue())) return;

      // Optimize video
      logger.info("video_process_optimize", { videoId, jobId, totalSeconds: progressState.totalSeconds });
      await optimizeVideo(
        inputFile,
        outputFile,
        probe,
        async (info) => {
          if (!(await shouldContinue())) return;
          await heartbeat(info.detail, {
            percent: info.percent,
            processedSeconds: info.processedSeconds,
            totalSeconds: info.totalSeconds,
          });
        },
        shouldContinue,
      );

      // Upload to staging path first
      await bucket.upload(outputFile, {
        destination: stagingOutputPath,
        metadata: { contentType: "video/mp4" },
      });

      logger.info("video_process_staged", { videoId, stagingOutputPath });

      // Check race before finalizing
      if (!(await shouldContinue())) {
        // Clean up staging file
        try {
          await bucket.file(stagingOutputPath).delete({ ignoreNotFound: true });
        } catch { /* ignore */ }
        return;
      }

      // Copy/move to canonical path
      const canonicalPath = `videos/${videoId}/optimized.mp4`;
      await bucket.file(stagingOutputPath).copy(bucket.file(canonicalPath));
      finalOptimizedPath = canonicalPath;
      finalPlaybackPath = canonicalPath;

      // Clean up staging file
      try {
        await bucket.file(stagingOutputPath).delete({ ignoreNotFound: true });
      } catch { /* ignore */ }

      // If deleted/cancelled after publish to canonical, remove the new asset so it cannot
      // resurrect playback for a permanently deleted video.
      if (!(await shouldContinue())) {
        try {
          await bucket.file(canonicalPath).delete({ ignoreNotFound: true });
        } catch { /* ignore */ }
        return;
      }

      logger.info("video_process_optimized", { videoId, optimizedPath: canonicalPath });

      // Re-probe the encoded file so duration/progress/slides are not stuck at 0
      // when the source WebM omitted format.duration (common for Matroska/WebM).
      try {
        const outProbe = await probeVideo(outputFile);
        if (outProbe.durationSeconds > 0) {
          probe = {
            ...probe,
            durationSeconds: outProbe.durationSeconds,
          };
        }
        logger.info("video_process_optimized_probe", {
          videoId,
          durationSeconds: outProbe.durationSeconds,
          videoCodec: outProbe.videoCodec,
          audioCodec: outProbe.audioCodec,
          containerFormat: outProbe.containerFormat,
          hasFastStart: outProbe.hasFastStart,
        });
      } catch (probeErr) {
        logger.warn("video_process_optimized_probe_failed", {
          videoId,
          error: String(probeErr),
        });
      }
    }

    // Update status to detecting slides
    if (!(await shouldContinue())) return;
    await videoRef.update({
      "processing.status": VIDEO_PROCESSING_STATUS.DETECTING_SLIDES,
      "processing.stage": VIDEO_PROCESSING_STATUS.DETECTING_SLIDES,
      "processing.lastProgressAt": nowIso(),
      "processing.stageDetail": "detect_slides",
      "processing.progressPercent": progressState.progressPercent != null ? 99 : null,
      updatedAt: nowIso(),
      updatedAtServer: FieldValue.serverTimestamp(),
    });

    // Check race before slide detection
    if (!(await shouldContinue())) return;

    // Detect slides (run even for SKIPPED_COMPATIBLE if no existing markers)
    const existingMarkers = video.slideMarkers as SlideMarker[] | null;
    let slideMarkers: SlideMarker[] = existingMarkers || [];
    
    if (!existingMarkers || existingMarkers.length === 0) {
      logger.info("video_process_detect_slides", { videoId });
      const slideTimestamps = await detectSlideChanges(inputFile, probe.durationSeconds);
      slideMarkers = buildSlideMarkers(slideTimestamps, "auto");

      logger.info("video_process_slides_detected", {
        videoId,
        slideCount: slideMarkers.length,
      });
    }

    // Update status to verifying
    if (!(await shouldContinue())) return;
    await videoRef.update({
      "processing.status": VIDEO_PROCESSING_STATUS.VERIFYING,
      "processing.stage": VIDEO_PROCESSING_STATUS.VERIFYING,
      "processing.lastProgressAt": nowIso(),
      "processing.stageDetail": "verify",
      updatedAt: nowIso(),
      updatedAtServer: FieldValue.serverTimestamp(),
    });

    // Verify the playback file exists
    const playbackFile = bucket.file(finalPlaybackPath);
    const [exists] = await playbackFile.exists();
    if (!exists) {
      throw new Error(`Playback file ${finalPlaybackPath} does not exist after processing`);
    }

    // Mark as ready only if still eligible (transactional race guard)
    const finalStatus = evaluation.needsOptimization
      ? VIDEO_PROCESSING_STATUS.READY
      : VIDEO_PROCESSING_STATUS.SKIPPED_COMPATIBLE;

    const completedIso = nowIso();
    const historyEntry: VideoProcessingHistoryEntry = {
      attempt,
      jobId,
      outcome: "completed",
      status: finalStatus,
      runtime: WORKER_RUNTIME,
      note: evaluation.needsOptimization ? "Cloud Run Job encode completed" : "Already compatible",
      startedAt: video.processing?.startedAt || video.processing?.queuedAt || null,
      finishedAt: completedIso,
      progressPercent: 100,
      processedSeconds: progressState.processedSeconds,
      totalSeconds: progressState.totalSeconds ?? probe.durationSeconds,
    };

    const committed = await db.runTransaction(async (tx) => {
      const freshSnap = await tx.get(videoRef);
      if (!freshSnap.exists) return false;
      const fresh = freshSnap.data()!;
      if (fresh.deleted === true || fresh.tombstone === true) return false;
      if (fresh.processing?.cancelled === true) return false;
      if ((fresh.processing?.generation ?? 0) !== startGeneration) return false;

      const history = mergeHistoryOnVideo(
        fresh.processing?.history as VideoProcessingHistoryEntry[] | undefined,
        historyEntry,
      );

      tx.update(videoRef, {
        "processing.status": finalStatus,
        "processing.stage": finalStatus,
        "processing.completedAt": completedIso,
        "processing.lastProgressAt": completedIso,
        "processing.stageDetail": "ready",
        "processing.progressPercent": 100,
        "processing.processedSeconds": progressState.totalSeconds ?? probe.durationSeconds,
        "processing.totalSeconds": progressState.totalSeconds ?? probe.durationSeconds,
        "processing.estimatedRemainingSeconds": 0,
        "processing.probeResult": probe,
        "processing.optimizedPath": finalOptimizedPath,
        "processing.playbackPath": finalPlaybackPath,
        "processing.errorCode": null,
        "processing.failureCategory": null,
        "processing.failureReason": null,
        "processing.history": history,
        "processing.runtime": WORKER_RUNTIME,
        optimizedStoragePath: finalOptimizedPath,
        playbackStoragePath: finalPlaybackPath,
        slideMarkers: slideMarkers.length > 0 ? slideMarkers : null,
        durationSeconds: probe.durationSeconds,
        updatedAt: completedIso,
        updatedAtServer: FieldValue.serverTimestamp(),
      });
      return true;
    });

    if (!committed) {
      if (finalOptimizedPath && finalOptimizedPath !== storagePath) {
        try {
          await bucket.file(finalOptimizedPath).delete({ ignoreNotFound: true });
        } catch { /* ignore */ }
      }
      logger.info("video_process_abort_before_commit", { videoId, generation: startGeneration });
      return;
    }

    logger.info("video_process_complete", {
      videoId,
      status: finalStatus,
      slideCount: slideMarkers.length,
    });

    await writeVideoProcessingDiagnostic({
      videoId,
      title: String(video.title || ""),
      jobId,
      attempt,
      stage: "ready",
      status: finalStatus,
      startedAt: video.processing?.startedAt || null,
      lastProgressAt: completedIso,
      progressPercent: 100,
      processedSeconds: progressState.totalSeconds ?? probe.durationSeconds,
      totalSeconds: progressState.totalSeconds ?? probe.durationSeconds,
      sourceDurationSeconds: probe.durationSeconds,
      runtime: WORKER_RUNTIME,
      outcome: "completed",
      companyId: video.companyId ?? null,
    });

    await writeAuditEvent({
      type: AUDIT_EVENT.VIDEO_PLAYBACK_ASSET_ACTIVATED,
      actorType: "system",
      payload: {
        videoId,
        jobId,
        generation: startGeneration,
        status: finalStatus,
        optimizedStoragePath: finalOptimizedPath,
        playbackStoragePath: finalPlaybackPath,
        durationSeconds: probe.durationSeconds,
        slideCount: slideMarkers.length,
        companyId: video.companyId ?? null,
      },
    });
  } catch (err) {
    const errorCode = generateErrorCode();
    const failureCategory =
      (err as { failureCategory?: string })?.failureCategory ||
      (err instanceof ProcessingStallError
        ? VIDEO_PROCESSING_FAILURE_CATEGORY.PROCESSING_STALLED
        : classifyFfmpegFailure(err));
    const failureReason = sanitizeProcessingErrorText(err);
    const exitCode =
      typeof (err as { exitCode?: unknown })?.exitCode === "number"
        ? ((err as { exitCode: number }).exitCode)
        : null;
    const signal =
      typeof (err as { signal?: unknown })?.signal === "string"
        ? ((err as { signal: string }).signal)
        : err instanceof ProcessingStallError
          ? err.signal
          : null;
    const failedIso = nowIso();
    const startedAt = video.processing?.startedAt || video.processing?.queuedAt || null;
    const elapsedMs = startedAt
      ? Date.now() - new Date(startedAt).getTime()
      : null;

    logger.error("video_process_failed", {
      videoId,
      errorCode,
      failureCategory,
      error: failureReason,
      jobId,
      exitCode,
      signal,
    });
    
    // Non-destructive: do NOT clear playbackStoragePath or optimizedStoragePath on failure.
    // Skip FAILED write if the video was deleted/cancelled mid-job.
    if (await shouldContinue()) {
      const freshSnap = await videoRef.get();
      const fresh = freshSnap.data() || video;
      const history = mergeHistoryOnVideo(
        fresh.processing?.history as VideoProcessingHistoryEntry[] | undefined,
        {
          attempt,
          jobId,
          outcome: "failed",
          status: VIDEO_PROCESSING_STATUS.FAILED,
          failureCategory,
          errorCode,
          runtime: WORKER_RUNTIME,
          note: failureReason.slice(0, 240),
          startedAt,
          finishedAt: failedIso,
          progressPercent: progressState.progressPercent,
          processedSeconds: progressState.processedSeconds,
          totalSeconds: progressState.totalSeconds,
        },
      );

      await videoRef.update({
        "processing.status": VIDEO_PROCESSING_STATUS.FAILED,
        "processing.stage": VIDEO_PROCESSING_STATUS.FAILED,
        "processing.failedAt": failedIso,
        "processing.failureReason": failureReason,
        "processing.failureCategory": failureCategory,
        "processing.errorCode": errorCode,
        "processing.lastProgressAt": failedIso,
        "processing.stageDetail": "failed",
        "processing.estimatedRemainingSeconds": null,
        "processing.history": history,
        "processing.runtime": WORKER_RUNTIME,
        updatedAt: failedIso,
        updatedAtServer: FieldValue.serverTimestamp(),
      });

      await writeVideoProcessingDiagnostic({
        videoId,
        title: String(video.title || ""),
        jobId,
        attempt,
        stage: String(fresh.processing?.stageDetail || fresh.processing?.status || "unknown"),
        status: VIDEO_PROCESSING_STATUS.FAILED,
        startedAt,
        lastProgressAt: failedIso,
        elapsedMs,
        progressPercent: progressState.progressPercent,
        processedSeconds: progressState.processedSeconds,
        totalSeconds: progressState.totalSeconds,
        sourceDurationSeconds: progressState.totalSeconds,
        runtime: WORKER_RUNTIME,
        exitCode,
        signal,
        terminationReason: failureCategory,
        ffmpegErrorSummary: failureReason,
        failureCategory,
        errorCode,
        outcome: "failed",
        companyId: video.companyId ?? null,
      });

      await writeAuditEvent({
        type: AUDIT_EVENT.VIDEO_PROCESSING_FAILED,
        actorType: "system",
        payload: {
          videoId,
          errorCode,
          jobId,
          generation: startGeneration,
          attempt,
          stage: fresh.processing?.stageDetail || "unknown",
          failureCategory,
          progressPercent: progressState.progressPercent,
          processedSeconds: progressState.processedSeconds,
          totalSeconds: progressState.totalSeconds,
          error: failureReason.slice(0, 1000),
          companyId: video.companyId ?? null,
        },
      });
    }
    throw err;
  } finally {
    // Cleanup temp files
    try {
      await fs.unlink(inputFile).catch(() => {});
      await fs.unlink(outputFile).catch(() => {});
    } catch {
      // Ignore cleanup errors
    }
  }
}

/** Firestore trigger: when processing.status becomes "uploaded", dispatch Cloud Run Job. */
export const onVideoProcessingQueued = onDocumentUpdated(
  {
    document: "videos/{videoId}",
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (event) => {
    const videoId = event.params.videoId;
    const before = event.data?.before.data();
    const after = event.data?.after.data();

    if (!before || !after) return;

    const beforeStatus = before.processing?.status;
    const afterStatus = after.processing?.status;

    // Only trigger when status changes to UPLOADED
    if (
      beforeStatus !== VIDEO_PROCESSING_STATUS.UPLOADED &&
      afterStatus === VIDEO_PROCESSING_STATUS.UPLOADED
    ) {
      const generation = (after.processing?.generation as number) ?? 0;
      const attempt = (after.processing?.attempt as number) ?? 1;
      const jobId =
        String(after.processing?.jobId || "").trim() ||
        `job_${videoId}_${generation}_${Date.now().toString(36)}`;

      logger.info("video_processing_triggered", {
        videoId,
        afterStatus,
        generation,
        jobId,
        attempt,
      });

      try {
        await db.collection("videos").doc(videoId).update({
          "processing.jobId": jobId,
          "processing.queuedAt": new Date().toISOString(),
          "processing.lastProgressAt": new Date().toISOString(),
          "processing.stageDetail": "dispatching_cloud_run_job",
          updatedAt: new Date().toISOString(),
          updatedAtServer: FieldValue.serverTimestamp(),
        });

        const { executionName } = await dispatchVideoProcessJob({
          videoId,
          generation,
          jobId,
          attempt,
        });

        await writeAuditEvent({
          type: AUDIT_EVENT.VIDEO_PROCESSING_JOB_DISPATCHED,
          actorType: "system",
          payload: {
            videoId,
            jobId,
            generation,
            attempt,
            executionName,
            companyId: after.companyId ?? null,
          },
        });
      } catch (err) {
        const errorCode = generateErrorCode();
        logger.error("video_processing_dispatch_failed", {
          videoId,
          errorCode,
          error: String(err),
        });
        await db.collection("videos").doc(videoId).update({
          "processing.status": VIDEO_PROCESSING_STATUS.FAILED,
          "processing.failedAt": new Date().toISOString(),
          "processing.failureReason": `Failed to dispatch processing job: ${
            err instanceof Error ? err.message : String(err)
          }`,
          "processing.errorCode": errorCode,
          "processing.lastProgressAt": new Date().toISOString(),
          "processing.stageDetail": "dispatch_failed",
          updatedAt: new Date().toISOString(),
          updatedAtServer: FieldValue.serverTimestamp(),
        });
        await writeAuditEvent({
          type: AUDIT_EVENT.VIDEO_PROCESSING_FAILED,
          actorType: "system",
          payload: {
            videoId,
            errorCode,
            stage: "dispatch",
            error: err instanceof Error ? err.message : String(err),
            companyId: after.companyId ?? null,
          },
        });
      }
    }
  },
);

/**
 * Queue video for processing/reprocessing (admin only).
 * Mode:
 * - "optimize" (default): Queue for optimization if not already ready
 * - "reprocess": Re-run processing even if already ready/skipped (caller confirms)
 */
export const queueVideoProcessing = onCall(
  { timeoutSeconds: 60 },
  async (request) => {
    const videoId = String(request.data?.videoId || "").trim();
    const mode = String(request.data?.mode || "optimize").trim() as "optimize" | "reprocess";
    
    if (!videoId) {
      throw new HttpsError("invalid-argument", "videoId required.");
    }

    const ctx = await loadStaffContext(request);
    assertHasPermission(ctx, PERMISSIONS.VIDEOS_MANAGE);

    const videoRef = db.collection("videos").doc(videoId);
    const videoSnap = await videoRef.get();
    if (!videoSnap.exists) {
      throw new HttpsError("not-found", "Video not found.");
    }

    const video = videoSnap.data()!;
    if (!ctx.isPlatformAdmin && video.companyId !== ctx.companyId) {
      throw new HttpsError("permission-denied", "Video belongs to another company.");
    }

    // Reject if permanently deleted or tombstone
    if (video.permanentlyDeletedAt || video.tombstone === true) {
      throw new HttpsError("failed-precondition", "Video has been permanently deleted.");
    }

    // Reject if no storagePath
    if (!video.storagePath) {
      throw new HttpsError("failed-precondition", "Video has no storage path.");
    }

    const currentStatus = video.processing?.status as string | undefined;
    const isReady = currentStatus === VIDEO_PROCESSING_STATUS.READY ||
                    currentStatus === VIDEO_PROCESSING_STATUS.SKIPPED_COMPATIBLE;

    // Prevent duplicate FFmpeg jobs while a worker is already active.
    if (isVideoProcessingInProgress(currentStatus)) {
      throw new HttpsError(
        "failed-precondition",
        `Video is already processing (${currentStatus}). Wait for completion/failure, or use Retry after Processing Failed.`,
      );
    }

    // For optimize mode, reject if already ready (use reprocess mode instead)
    if (mode === "optimize" && isReady) {
      throw new HttpsError(
        "failed-precondition",
        "Video is already optimized. Use mode='reprocess' to re-run processing."
      );
    }

    const nowIso = new Date().toISOString();
    const currentGeneration = (video.processing?.generation as number) ?? 0;
    const nextGeneration = currentGeneration + 1;
    const nextAttempt = ((video.processing?.attempt as number) ?? 0) + 1;
    const jobId = `job_${videoId}_${nextGeneration}_${Date.now().toString(36)}`;

    // Reset processing state with incremented generation
    const history = appendProcessingHistory(
      video.processing?.history,
      {
        attempt: nextAttempt,
        jobId,
        outcome: "queued",
        status: VIDEO_PROCESSING_STATUS.UPLOADED,
        runtime: "cloud_run_job",
        note: mode === "reprocess" ? "Reprocess queued" : "Optimize queued",
        startedAt: nowIso,
        finishedAt: null,
      },
    );

    await videoRef.update({
      "processing.status": VIDEO_PROCESSING_STATUS.UPLOADED,
      "processing.stage": VIDEO_PROCESSING_STATUS.UPLOADED,
      "processing.generation": nextGeneration,
      "processing.attempt": nextAttempt,
      "processing.jobId": jobId,
      "processing.requestedBy": ctx.uid,
      "processing.requestedAt": nowIso,
      "processing.queuedAt": nowIso,
      "processing.lastProgressAt": nowIso,
      "processing.progressPercent": null,
      "processing.processedSeconds": null,
      "processing.totalSeconds": null,
      "processing.estimatedRemainingSeconds": null,
      "processing.stageDetail": "queued",
      "processing.startedAt": null,
      "processing.completedAt": null,
      "processing.failedAt": null,
      "processing.failureReason": null,
      "processing.failureCategory": null,
      "processing.errorCode": null,
      "processing.cancelled": false,
      "processing.runtime": "cloud_run_job",
      "processing.history": history,
      updatedAt: nowIso,
      updatedAtServer: FieldValue.serverTimestamp(),
    });

    const eventType = mode === "reprocess"
      ? AUDIT_EVENT.VIDEO_REPROCESS_REQUESTED
      : AUDIT_EVENT.VIDEO_OPTIMIZATION_REQUESTED;

    await writeAuditEvent({
      type: eventType,
      actorUid: ctx.uid,
      actorType: "administrator",
      payload: { videoId, mode, generation: nextGeneration, attempt: nextAttempt, jobId },
    });

    logger.info("video_processing_queued", {
      videoId,
      mode,
      generation: nextGeneration,
      attempt: nextAttempt,
      jobId,
      by: ctx.uid,
    });

    return {
      ok: true,
      videoId,
      mode,
      generation: nextGeneration,
      attempt: nextAttempt,
      jobId,
      message: mode === "reprocess"
        ? "Video queued for reprocessing."
        : "Video queued for optimization.",
    };
  },
);

/**
 * Bulk optimize existing videos that need processing.
 * Queues up to N videos (default 20) by setting UPLOADED + incrementing generation.
 * Does NOT run FFmpeg - relies on Firestore trigger for per-video processing.
 */
export const optimizeExistingVideos = onCall(
  { timeoutSeconds: 120 },
  async (request) => {
    const limit = Math.min(Number(request.data?.limit || 20), 50);
    
    const ctx = await loadStaffContext(request);
    assertHasPermission(ctx, PERMISSIONS.VIDEOS_MANAGE);

    // Resolve company
    let companyId: string;
    if (ctx.isPlatformAdmin && !ctx.companyId) {
      const settings = await getPortalSettings();
      companyId = resolveActingCompanyId(ctx, settings.defaultCompanyId || null);
    } else {
      companyId = resolveActingCompanyId(ctx, request.data?.companyId);
    }

    // Query videos that need optimization:
    // - Has storagePath
    // - Not deleted/tombstone
    // - processing missing OR status failed OR never ready/skipped
    const snap = await db.collection("videos")
      .where("companyId", "==", companyId)
      .get();

    const eligibleVideos = snap.docs.filter((doc) => {
      const v = doc.data();
      // Must have storagePath
      if (!v.storagePath) return false;
      // Must not be deleted/tombstone
      if (v.deleted === true || v.tombstone === true || v.permanentlyDeletedAt) return false;
      // Must not be archived
      if (v.archived === true || v.status === VIDEO_STATUS.ARCHIVED) return false;
      // Check processing state
      const status = v.processing?.status as string | undefined;
      if (!status) return true; // No processing state - needs optimization
      if (status === VIDEO_PROCESSING_STATUS.FAILED) return true; // Failed - retry
      if (status === VIDEO_PROCESSING_STATUS.READY) return false; // Already ready
      if (status === VIDEO_PROCESSING_STATUS.SKIPPED_COMPATIBLE) return false; // Already compatible
      // In-progress states or pending - check if stale
      if (status === VIDEO_PROCESSING_STATUS.UPLOADED) return false; // Already queued
      return true;
    });

    const nowIso = new Date().toISOString();
    const queuedIds: string[] = [];
    let skipped = 0;

    for (const doc of eligibleVideos.slice(0, limit)) {
      const v = doc.data();
      const currentGeneration = (v.processing?.generation as number) ?? 0;
      const nextGeneration = currentGeneration + 1;

      try {
        await doc.ref.update({
          "processing.status": VIDEO_PROCESSING_STATUS.UPLOADED,
          "processing.generation": nextGeneration,
          "processing.requestedBy": ctx.uid,
          "processing.requestedAt": nowIso,
          "processing.failedAt": null,
          "processing.failureReason": null,
          "processing.errorCode": null,
          "processing.cancelled": false,
          updatedAt: nowIso,
          updatedAtServer: FieldValue.serverTimestamp(),
        });
        queuedIds.push(doc.id);
      } catch (err) {
        logger.warn("bulk_optimize_video_failed", { videoId: doc.id, error: String(err) });
        skipped++;
      }
    }

    skipped += Math.max(0, eligibleVideos.length - limit);

    await writeAuditEvent({
      type: AUDIT_EVENT.VIDEO_BULK_OPTIMIZATION_REQUESTED,
      actorUid: ctx.uid,
      actorType: "administrator",
      payload: {
        companyId,
        queued: queuedIds.length,
        skipped,
        videoIds: queuedIds,
      },
    });

    logger.info("bulk_optimize_videos_queued", {
      companyId,
      queued: queuedIds.length,
      skipped,
      by: ctx.uid,
    });

    return {
      ok: true,
      queued: queuedIds.length,
      skipped,
      videoIds: queuedIds,
      message: `Queued ${queuedIds.length} videos for optimization. ${skipped} skipped.`,
      note: "Firestore triggers provide per-video isolation; one failure does not stop others.",
    };
  },
);

/** Update slide markers manually (admin only) */
export const updateVideoSlideMarkers = onCall(async (request) => {
  const videoId = String(request.data?.videoId || "").trim();
  const markers = request.data?.markers as SlideMarker[] | undefined;

  if (!videoId) {
    throw new HttpsError("invalid-argument", "videoId required.");
  }

  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.VIDEOS_MANAGE);

  const videoRef = db.collection("videos").doc(videoId);
  const videoSnap = await videoRef.get();
  if (!videoSnap.exists) {
    throw new HttpsError("not-found", "Video not found.");
  }

  const video = videoSnap.data()!;
  if (!ctx.isPlatformAdmin && video.companyId !== ctx.companyId) {
    throw new HttpsError("permission-denied", "Video belongs to another company.");
  }

  // Validate and normalize markers
  const durationSeconds = video.durationSeconds || 0;
  const validMarkers: SlideMarker[] = [];

  if (Array.isArray(markers)) {
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i];
      if (
        typeof m === "object" &&
        m !== null &&
        typeof m.timeSeconds === "number" &&
        m.timeSeconds >= 0 &&
        m.timeSeconds < durationSeconds
      ) {
        validMarkers.push({
          id: m.id || `slide_${i}`,
          index: i,
          timeSeconds: m.timeSeconds,
          title: typeof m.title === "string" ? m.title : null,
          source: "manual",
        });
      }
    }
  }

  await videoRef.update({
    slideMarkers: validMarkers.length > 0 ? validMarkers : null,
    updatedAt: new Date().toISOString(),
    updatedAtServer: FieldValue.serverTimestamp(),
  });

  await writeAuditEvent({
    type: "video_slide_markers_updated" as never,
    actorUid: ctx.uid,
    actorType: "administrator",
    payload: { videoId, markerCount: validMarkers.length },
  });

  return {
    ok: true,
    videoId,
    markerCount: validMarkers.length,
  };
});
