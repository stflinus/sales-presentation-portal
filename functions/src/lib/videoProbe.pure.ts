/**
 * Pure, testable functions for video processing logic.
 * No Firebase dependencies — designed for unit testing.
 */

import type {
  VideoProbeResult,
  SlideMarker,
  VideoProcessingStatus,
} from "../shared";
import { VIDEO_STREAMING_PROFILE, VIDEO_PROCESSING_STATUS, SLIDE_RESTART_THRESHOLD_SECONDS } from "../shared";

export interface StreamingEvaluation {
  needsOptimization: boolean;
  reasons: string[];
  targetProfile: typeof VIDEO_STREAMING_PROFILE;
}

/**
 * Evaluate whether a video needs optimization for streaming.
 * Returns true if transcoding is required.
 */
export function evaluateStreamingProfile(
  probe: VideoProbeResult,
): StreamingEvaluation {
  const reasons: string[] = [];
  const profile = VIDEO_STREAMING_PROFILE;

  // Check container format (must be MP4)
  const container = probe.containerFormat.toLowerCase();
  if (!container.includes("mp4") && !container.includes("mov")) {
    reasons.push(`Container ${probe.containerFormat} is not MP4`);
  }

  // Check video codec (must be H.264)
  const videoCodec = probe.videoCodec.toLowerCase();
  if (!videoCodec.includes("h264") && !videoCodec.includes("avc")) {
    reasons.push(`Video codec ${probe.videoCodec} is not H.264`);
  }

  // Check audio codec (must be AAC or no audio)
  if (probe.audioCodec) {
    const audioCodec = probe.audioCodec.toLowerCase();
    if (!audioCodec.includes("aac")) {
      reasons.push(`Audio codec ${probe.audioCodec} is not AAC`);
    }
  }

  // Check faststart (moov atom at beginning)
  if (!probe.hasFastStart) {
    reasons.push("Missing faststart (moov atom not at beginning)");
  }

  // Check resolution (max 1080p)
  if (probe.height > profile.maxHeight) {
    reasons.push(`Height ${probe.height}px exceeds ${profile.maxHeight}px`);
  }

  // Check bitrate (target 3500kbps, allow up to 2x)
  if (
    probe.videoBitrateKbps &&
    probe.videoBitrateKbps > profile.targetVideoBitrateKbps * 2
  ) {
    reasons.push(
      `Bitrate ${probe.videoBitrateKbps}kbps exceeds target ${profile.targetVideoBitrateKbps * 2}kbps`,
    );
  }

  return {
    needsOptimization: reasons.length > 0,
    reasons,
    targetProfile: profile,
  };
}

/**
 * Filter and validate slide timestamps.
 * Removes invalid, duplicate, and out-of-bounds timestamps.
 */
export function filterSlideTimestamps(
  timestamps: number[],
  durationSeconds: number,
): number[] {
  const validTimestamps = timestamps
    .filter((t) => Number.isFinite(t) && t >= 0 && t < durationSeconds)
    .sort((a, b) => a - b);

  // Remove duplicates within 0.5 second tolerance
  const deduplicated: number[] = [];
  for (const t of validTimestamps) {
    if (deduplicated.length === 0 || t - deduplicated[deduplicated.length - 1] > 0.5) {
      deduplicated.push(t);
    }
  }

  return deduplicated;
}

/**
 * Build slide markers from detected timestamps.
 */
export function buildSlideMarkers(
  timestamps: number[],
  source: "auto" | "manual" = "auto",
): SlideMarker[] {
  return timestamps.map((timeSeconds, index) => ({
    id: `slide_${index}`,
    index,
    timeSeconds,
    title: null,
    source,
  }));
}

export interface SlideNavigationResult {
  targetSlide: SlideMarker | null;
  targetTime: number;
  action: "restart" | "previous" | "next" | "none";
}

/**
 * Resolve slide navigation based on current time and direction.
 * If within SLIDE_RESTART_THRESHOLD_SECONDS of slide start, prev goes to previous slide.
 * Otherwise, prev restarts current slide.
 */
export function resolveSlideNavigation(
  currentTime: number,
  direction: "prev" | "next",
  slideMarkers: SlideMarker[],
  durationSeconds: number,
): SlideNavigationResult {
  if (!slideMarkers || slideMarkers.length === 0) {
    return {
      targetSlide: null,
      targetTime: direction === "prev" ? 0 : durationSeconds,
      action: "none",
    };
  }

  // Sort markers by time
  const sorted = [...slideMarkers].sort((a, b) => a.timeSeconds - b.timeSeconds);

  // Find current slide index
  let currentSlideIndex = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (currentTime >= sorted[i].timeSeconds) {
      currentSlideIndex = i;
      break;
    }
  }

  const currentSlide = sorted[currentSlideIndex];
  const timeIntoSlide = currentTime - currentSlide.timeSeconds;

  if (direction === "prev") {
    // If we're more than threshold into the slide, restart current slide
    if (timeIntoSlide > SLIDE_RESTART_THRESHOLD_SECONDS) {
      return {
        targetSlide: currentSlide,
        targetTime: currentSlide.timeSeconds,
        action: "restart",
      };
    }
    // Otherwise, go to previous slide (or start if at first slide)
    if (currentSlideIndex > 0) {
      const prevSlide = sorted[currentSlideIndex - 1];
      return {
        targetSlide: prevSlide,
        targetTime: prevSlide.timeSeconds,
        action: "previous",
      };
    }
    // At first slide, go to start
    return {
      targetSlide: sorted[0],
      targetTime: 0,
      action: "restart",
    };
  }

  // direction === "next"
  if (currentSlideIndex < sorted.length - 1) {
    const nextSlide = sorted[currentSlideIndex + 1];
    return {
      targetSlide: nextSlide,
      targetTime: nextSlide.timeSeconds,
      action: "next",
    };
  }

  // At last slide, stay at current position (or go to end)
  return {
    targetSlide: sorted[sorted.length - 1],
    targetTime: currentTime,
    action: "none",
  };
}

/**
 * Map processing status to human-readable label.
 */
export function processingStatusLabel(status: VideoProcessingStatus): string {
  const labels: Record<VideoProcessingStatus, string> = {
    [VIDEO_PROCESSING_STATUS.PENDING_UPLOAD]: "Pending Upload",
    [VIDEO_PROCESSING_STATUS.UPLOADED]: "Uploaded",
    [VIDEO_PROCESSING_STATUS.ANALYZING]: "Analyzing",
    [VIDEO_PROCESSING_STATUS.OPTIMIZING]: "Optimizing",
    [VIDEO_PROCESSING_STATUS.DETECTING_SLIDES]: "Detecting Slides",
    [VIDEO_PROCESSING_STATUS.VERIFYING]: "Verifying",
    [VIDEO_PROCESSING_STATUS.READY]: "Ready",
    [VIDEO_PROCESSING_STATUS.FAILED]: "Failed",
    [VIDEO_PROCESSING_STATUS.SKIPPED_COMPATIBLE]: "Ready (Compatible)",
  };
  return labels[status] || status;
}
