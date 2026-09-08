/**
 * Pure helpers for presentation video FPS normalization, FFmpeg plan,
 * and post-encode output validation. No Firebase / FFmpeg process deps.
 */

import {
  VIDEO_STREAMING_PROFILE,
  type VideoProbeResult,
} from "../shared";

export interface FrameRateNormalization {
  reportedFps: number | null;
  selectedFps: number;
  wasNormalized: boolean;
  note: string | null;
}

/** Parse ffprobe rate strings like "30/1", "1000/1", "0/0". */
export function parseFrameRateFraction(
  value: string | null | undefined,
): number | null {
  if (!value || value === "0/0" || value === "N/A") return null;
  const [numStr, denStr] = String(value).split("/");
  const num = Number(numStr);
  const den = denStr == null || denStr === "" ? 1 : Number(denStr);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const rate = num / den;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return rate;
}

/**
 * Choose a sane CFR for portal streaming.
 * - <= 60: preserve (rounded)
 * - > 60 or unknown: 30 FPS
 */
export function normalizeOutputFrameRate(
  reportedFps: number | null | undefined,
  profile: typeof VIDEO_STREAMING_PROFILE = VIDEO_STREAMING_PROFILE,
): FrameRateNormalization {
  const maxSane = profile.maxSaneFrameRate;
  const fallback = profile.defaultOutputFrameRate;

  if (reportedFps == null || !Number.isFinite(reportedFps) || reportedFps <= 0) {
    return {
      reportedFps: reportedFps ?? null,
      selectedFps: fallback,
      wasNormalized: true,
      note: `Source FPS unknown/invalid. Normalized to ${fallback} FPS for portal playback.`,
    };
  }

  if (reportedFps > maxSane) {
    const rounded = Math.round(reportedFps);
    return {
      reportedFps,
      selectedFps: fallback,
      wasNormalized: true,
      note: `Source reported ${rounded} FPS. Normalized to ${fallback} FPS for portal playback.`,
    };
  }

  const selectedFps = Math.round(reportedFps * 1000) / 1000;
  return {
    reportedFps,
    selectedFps,
    wasNormalized: false,
    note: null,
  };
}

export function buildOptimizeVideoFilter(
  selectedFps: number,
  maxHeight: number = VIDEO_STREAMING_PROFILE.maxHeight,
): string {
  const fps = Number.isFinite(selectedFps) && selectedFps > 0
    ? selectedFps
    : VIDEO_STREAMING_PROFILE.defaultOutputFrameRate;
  return `fps=${fps},scale=-2:'min(${maxHeight},ih)'`;
}

export function buildOptimizeEncodePlan(probe: VideoProbeResult): {
  normalization: FrameRateNormalization;
  videoFilter: string;
  maxrateKbps: number;
  bufsizeKbps: number;
  audioBitrateKbps: number;
} {
  const profile = VIDEO_STREAMING_PROFILE;
  const reported =
    probe.reportedFrameRate != null ? probe.reportedFrameRate : probe.frameRate;
  const normalization = normalizeOutputFrameRate(reported, profile);
  return {
    normalization,
    videoFilter: buildOptimizeVideoFilter(
      normalization.selectedFps,
      profile.maxHeight,
    ),
    maxrateKbps: profile.targetVideoBitrateKbps,
    bufsizeKbps: profile.targetVideoBitrateKbps * 2,
    audioBitrateKbps: profile.targetAudioBitrateKbps,
  };
}

export interface OptimizedOutputValidation {
  ok: boolean;
  reasons: string[];
  expectedFrameCount: number | null;
  metrics: {
    outputFps: number | null;
    outputNbFrames: number | null;
    outputDurationSeconds: number;
    outputBitrateKbps: number | null;
    outputHeight: number;
    hasFastStart: boolean;
  };
}

/**
 * Validate encoded output before activating playbackStoragePath.
 * Uses duration × FPS tolerances — not hardcoded to a single video.
 */
export function validateOptimizedOutput(input: {
  output: VideoProbeResult;
  source: VideoProbeResult;
  selectedOutputFps: number;
  outputBytes?: number | null;
}): OptimizedOutputValidation {
  const reasons: string[] = [];
  const { output, source, selectedOutputFps } = input;
  const profile = VIDEO_STREAMING_PROFILE;

  const container = output.containerFormat.toLowerCase();
  if (!container.includes("mp4") && !container.includes("mov")) {
    reasons.push(`Output container ${output.containerFormat} is not MP4`);
  }

  const vcodec = output.videoCodec.toLowerCase();
  if (!vcodec.includes("h264") && !vcodec.includes("avc")) {
    reasons.push(`Output video codec ${output.videoCodec} is not H.264`);
  }

  if (output.audioCodec || source.audioCodec) {
    const acodec = String(output.audioCodec || "").toLowerCase();
    if (!acodec.includes("aac")) {
      reasons.push(
        `Output audio codec ${output.audioCodec || "missing"} is not AAC`,
      );
    }
  }

  if (!output.hasFastStart) {
    reasons.push("Output missing faststart (moov atom not at beginning)");
  }

  if (output.height > profile.maxHeight) {
    reasons.push(
      `Output height ${output.height}px exceeds ${profile.maxHeight}px`,
    );
  }

  if (!Number.isFinite(output.durationSeconds) || output.durationSeconds <= 0) {
    reasons.push("Output duration is missing or zero");
  } else if (
    Number.isFinite(source.durationSeconds) &&
    source.durationSeconds > 0
  ) {
    const delta = Math.abs(output.durationSeconds - source.durationSeconds);
    const rel = delta / source.durationSeconds;
    if (delta > 3 && rel > 0.05) {
      reasons.push(
        `Output duration ${output.durationSeconds.toFixed(1)}s diverges from source ${source.durationSeconds.toFixed(1)}s`,
      );
    }
  }

  const outFps =
    output.frameRate != null && Number.isFinite(output.frameRate)
      ? output.frameRate
      : output.reportedFrameRate != null &&
          Number.isFinite(output.reportedFrameRate)
        ? output.reportedFrameRate
        : null;

  if (outFps == null || outFps <= 0) {
    reasons.push("Output FPS is missing or invalid");
  } else if (outFps > profile.maxSaneFrameRate) {
    reasons.push(
      `Output FPS ${Math.round(outFps)} is pathological (>${profile.maxSaneFrameRate})`,
    );
  }

  const fpsForCount =
    Number.isFinite(selectedOutputFps) && selectedOutputFps > 0
      ? selectedOutputFps
      : outFps;
  let expectedFrameCount: number | null = null;
  if (
    fpsForCount != null &&
    output.durationSeconds > 0 &&
    Number.isFinite(output.durationSeconds)
  ) {
    expectedFrameCount = output.durationSeconds * fpsForCount;
    const nb = output.nbFrames;
    if (nb != null && Number.isFinite(nb) && nb > 0) {
      const ratio = nb / expectedFrameCount;
      // Allow ~20% slack for CFR rounding / keyframe edge frames.
      if (ratio > 1.25 || ratio < 0.75) {
        reasons.push(
          `Output frame count ${nb} inconsistent with ~${Math.round(expectedFrameCount)} expected (duration×${fpsForCount}fps)`,
        );
      }
      // Absolute pathological guard (e.g. 1.35M frames on a 22-minute talk).
      if (nb > output.durationSeconds * (profile.maxSaneFrameRate + 5)) {
        reasons.push(
          `Output frame count ${nb} implies >${profile.maxSaneFrameRate} FPS average`,
        );
      }
    }
  }

  if (input.outputBytes != null) {
    if (!Number.isFinite(input.outputBytes) || input.outputBytes <= 0) {
      reasons.push("Output file is missing or empty");
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    expectedFrameCount,
    metrics: {
      outputFps: outFps,
      outputNbFrames: output.nbFrames ?? null,
      outputDurationSeconds: output.durationSeconds,
      outputBitrateKbps: output.videoBitrateKbps,
      outputHeight: output.height,
      hasFastStart: output.hasFastStart,
    },
  };
}

/**
 * Encode-loop abort polarity.
 * The continue guard returns true when the job should keep running.
 * Abort only when that guard returns false (cancelled / superseded / deleted).
 * VID-D534B5: shouldContinue was wired as shouldAbort and inverted this check.
 */
export function shouldKillEncodeForContinueGuard(
  continueAllowed: boolean,
): boolean {
  return continueAllowed === false;
}

/** Activation gate: never flip playback paths when validation failed. */
export function shouldActivateOptimizedPlayback(input: {
  validationOk: boolean;
  encodedNewAsset: boolean;
}): boolean {
  if (!input.encodedNewAsset) return false;
  return input.validationOk;
}
