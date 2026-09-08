import { describe, expect, it } from "vitest";
import { validateOptimizedOutput } from "../../functions/src/lib/videoOptimize.pure";
import type { VideoProbeResult } from "../../packages/shared/src";

/**
 * Part 13: company-default "Sales Presentation" optimized asset
 * (2cABIGuqvzBfCtzDFy1D) is the same pathological 1000fps class as pre-fix Dan.
 * Validation must reject it so a Part 11+ reprocess cannot activate it again.
 */
describe("Part 13 Sales Presentation pathological optimized asset", () => {
  const source: VideoProbeResult = {
    durationSeconds: 625.122,
    width: 1920,
    height: 1080,
    videoCodec: "vp9",
    audioCodec: "opus",
    containerFormat: "matroska,webm",
    videoBitrateKbps: null,
    audioBitrateKbps: null,
    frameRate: 30,
    reportedFrameRate: 1000,
    frameRateNormalized: true,
    hasFastStart: false,
  };

  const pathologicalOptimized: VideoProbeResult = {
    durationSeconds: 625.121333,
    width: 1920,
    height: 1080,
    videoCodec: "h264",
    audioCodec: "aac",
    containerFormat: "mov,mp4,m4a,3gp,3g2,mj2",
    videoBitrateKbps: 3267,
    audioBitrateKbps: 124,
    frameRate: 1000,
    reportedFrameRate: 1000,
    nbFrames: 624438,
    hasFastStart: true,
  };

  it("rejects the Aug-24 Sales Presentation optimized encode (~1000fps / 624k frames)", () => {
    const v = validateOptimizedOutput({
      output: pathologicalOptimized,
      source,
      selectedOutputFps: 30,
      outputBytes: 273060647,
    });
    expect(v.ok).toBe(false);
    expect(
      v.reasons.some((r) => /pathological|frame count|inconsistent/i.test(r)),
    ).toBe(true);
  });

  it("would accept a corrected ~30fps encode for the same duration", () => {
    const expectedFrames = Math.round(625.12 * 30);
    const v = validateOptimizedOutput({
      output: {
        ...pathologicalOptimized,
        frameRate: 30,
        reportedFrameRate: 30,
        nbFrames: expectedFrames,
        videoBitrateKbps: 2100,
      },
      source,
      selectedOutputFps: 30,
      outputBytes: 120_000_000,
    });
    expect(v.ok).toBe(true);
  });
});
