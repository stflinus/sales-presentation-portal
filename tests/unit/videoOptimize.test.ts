import { describe, expect, it } from "vitest";
import {
  buildOptimizeEncodePlan,
  buildOptimizeVideoFilter,
  normalizeOutputFrameRate,
  parseFrameRateFraction,
  shouldActivateOptimizedPlayback,
  shouldKillEncodeForContinueGuard,
  validateOptimizedOutput,
} from "../../functions/src/lib/videoOptimize.pure";
import { evaluateStreamingProfile } from "../../functions/src/lib/videoProbe.pure";
import {
  VIDEO_STREAMING_PROFILE,
  type VideoProbeResult,
} from "../../packages/shared/src";

const baseCompatible: VideoProbeResult = {
  durationSeconds: 1349.65,
  width: 1920,
  height: 1080,
  videoCodec: "h264",
  audioCodec: "aac",
  containerFormat: "mp4",
  videoBitrateKbps: 2200,
  audioBitrateKbps: 128,
  frameRate: 30,
  reportedFrameRate: 30,
  frameRateNormalized: false,
  frameRateNote: null,
  nbFrames: 40490,
  hasFastStart: true,
};

describe("parseFrameRateFraction", () => {
  it("parses common fractions", () => {
    expect(parseFrameRateFraction("24/1")).toBe(24);
    expect(parseFrameRateFraction("30/1")).toBe(30);
    expect(parseFrameRateFraction("60/1")).toBe(60);
    expect(parseFrameRateFraction("1000/1")).toBe(1000);
  });

  it("rejects invalid rates", () => {
    expect(parseFrameRateFraction("0/0")).toBeNull();
    expect(parseFrameRateFraction(null)).toBeNull();
    expect(parseFrameRateFraction("N/A")).toBeNull();
  });
});

describe("normalizeOutputFrameRate", () => {
  it("preserves 24 FPS", () => {
    const n = normalizeOutputFrameRate(24);
    expect(n.selectedFps).toBe(24);
    expect(n.wasNormalized).toBe(false);
  });

  it("preserves 30 FPS", () => {
    const n = normalizeOutputFrameRate(30);
    expect(n.selectedFps).toBe(30);
    expect(n.wasNormalized).toBe(false);
  });

  it("preserves 60 FPS", () => {
    const n = normalizeOutputFrameRate(60);
    expect(n.selectedFps).toBe(60);
    expect(n.wasNormalized).toBe(false);
  });

  it("normalizes pathological 1000 FPS to 30", () => {
    const n = normalizeOutputFrameRate(1000);
    expect(n.selectedFps).toBe(30);
    expect(n.wasNormalized).toBe(true);
    expect(n.note).toContain("1000");
    expect(n.note).toContain("30 FPS");
  });

  it("normalizes unknown/invalid FPS to 30", () => {
    expect(normalizeOutputFrameRate(null).selectedFps).toBe(30);
    expect(normalizeOutputFrameRate(null).wasNormalized).toBe(true);
    expect(normalizeOutputFrameRate(0).wasNormalized).toBe(true);
    expect(normalizeOutputFrameRate(-1).wasNormalized).toBe(true);
  });
});

describe("buildOptimizeEncodePlan / bitrate profile", () => {
  it("targets ~2250 kbps video and applies fps filter", () => {
    expect(VIDEO_STREAMING_PROFILE.targetVideoBitrateKbps).toBe(2250);
    const plan = buildOptimizeEncodePlan({
      ...baseCompatible,
      reportedFrameRate: 1000,
      frameRate: 30,
    });
    expect(plan.maxrateKbps).toBe(2250);
    expect(plan.audioBitrateKbps).toBe(128);
    expect(plan.videoFilter).toBe("fps=30,scale=-2:'min(1080,ih)'");
    expect(plan.normalization.selectedFps).toBe(30);
  });

  it("preserves 24 FPS in the video filter", () => {
    expect(buildOptimizeVideoFilter(24)).toContain("fps=24");
  });
});

describe("evaluateStreamingProfile frame-rate sanity", () => {
  it("keeps already-compatible sane MP4 off the encode path", () => {
    const result = evaluateStreamingProfile(baseCompatible);
    expect(result.needsOptimization).toBe(false);
    expect(result.selectedOutputFps).toBe(30);
  });

  it("requires optimization for pathological FPS even if codecs look fine", () => {
    const result = evaluateStreamingProfile({
      ...baseCompatible,
      reportedFrameRate: 1000,
      frameRate: 30,
      frameRateNormalized: true,
    });
    expect(result.needsOptimization).toBe(true);
    expect(result.frameRateNote).toMatch(/1000/);
  });

  it("requires optimization for Dan-style WebM/VP9 with 1000 FPS", () => {
    const result = evaluateStreamingProfile({
      ...baseCompatible,
      containerFormat: "matroska,webm",
      videoCodec: "vp9",
      audioCodec: "opus",
      hasFastStart: false,
      reportedFrameRate: 1000,
      frameRate: 30,
      videoBitrateKbps: null,
    });
    expect(result.needsOptimization).toBe(true);
    expect(result.selectedOutputFps).toBe(30);
  });
});

describe("validateOptimizedOutput", () => {
  it("accepts a sane ~30fps encode for a 22.5-minute talk", () => {
    const output: VideoProbeResult = {
      ...baseCompatible,
      nbFrames: 40490,
      frameRate: 30,
      reportedFrameRate: 30,
      videoBitrateKbps: 2100,
      hasFastStart: true,
    };
    const v = validateOptimizedOutput({
      output,
      source: baseCompatible,
      selectedOutputFps: 30,
      outputBytes: 350_000_000,
    });
    expect(v.ok).toBe(true);
    expect(v.expectedFrameCount).toBeCloseTo(1349.65 * 30, 0);
  });

  it("rejects pathological 1000fps / 1.35M frame outputs", () => {
    const output: VideoProbeResult = {
      ...baseCompatible,
      nbFrames: 1_348_996,
      frameRate: 1000,
      reportedFrameRate: 1000,
      videoBitrateKbps: 3288,
      hasFastStart: true,
    };
    const v = validateOptimizedOutput({
      output,
      source: baseCompatible,
      selectedOutputFps: 30,
      outputBytes: 593_662_335,
    });
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r) => /pathological|frame count|inconsistent/i.test(r))).toBe(
      true,
    );
  });

  it("rejects duration mismatch", () => {
    const v = validateOptimizedOutput({
      output: { ...baseCompatible, durationSeconds: 100 },
      source: baseCompatible,
      selectedOutputFps: 30,
      outputBytes: 10_000_000,
    });
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r) => /duration/i.test(r))).toBe(true);
  });

  it("rejects missing faststart", () => {
    const v = validateOptimizedOutput({
      output: { ...baseCompatible, hasFastStart: false },
      source: baseCompatible,
      selectedOutputFps: 30,
      outputBytes: 10_000_000,
    });
    expect(v.ok).toBe(false);
  });
});

describe("shouldActivateOptimizedPlayback", () => {
  it("never activates when validation failed", () => {
    expect(
      shouldActivateOptimizedPlayback({
        validationOk: false,
        encodedNewAsset: true,
      }),
    ).toBe(false);
  });

  it("activates only when validation passed for a new asset", () => {
    expect(
      shouldActivateOptimizedPlayback({
        validationOk: true,
        encodedNewAsset: true,
      }),
    ).toBe(true);
    expect(
      shouldActivateOptimizedPlayback({
        validationOk: true,
        encodedNewAsset: false,
      }),
    ).toBe(false);
  });
});

describe("shouldKillEncodeForContinueGuard (VID-D534B5 regression)", () => {
  it("does NOT kill encode when continue guard allows (healthy generation)", () => {
    // Bug: treating shouldContinue()===true as abort killed Dan's gen-6 job immediately.
    expect(shouldKillEncodeForContinueGuard(true)).toBe(false);
  });

  it("kills encode only when continue guard denies (cancelled/superseded)", () => {
    expect(shouldKillEncodeForContinueGuard(false)).toBe(true);
  });
});
