import { describe, expect, it } from "vitest";
import {
  evaluateStreamingProfile,
  filterSlideTimestamps,
  resolveSlideNavigation,
} from "../../functions/src/lib/videoProbe.pure";
import {
  ACCESS_POLICY,
  simplifyAccessPolicyForAdmin,
  SLIDE_RESTART_THRESHOLD_SECONDS,
  type VideoProbeResult,
  type SlideMarker,
} from "../../packages/shared/src";

describe("evaluateStreamingProfile", () => {
  const compatibleProbe: VideoProbeResult = {
    durationSeconds: 1320,
    width: 1920,
    height: 1080,
    videoCodec: "h264",
    audioCodec: "aac",
    containerFormat: "mp4",
    videoBitrateKbps: 3000,
    audioBitrateKbps: 128,
    frameRate: 30,
    hasFastStart: true,
  };

  it("skips optimization for compatible H.264/AAC MP4 with faststart", () => {
    const result = evaluateStreamingProfile(compatibleProbe);
    expect(result.needsOptimization).toBe(false);
    expect(result.reasons).toHaveLength(0);
  });

  it("requires optimization for WebM/VP9", () => {
    const webmProbe: VideoProbeResult = {
      ...compatibleProbe,
      containerFormat: "webm",
      videoCodec: "vp9",
      audioCodec: "opus",
    };
    const result = evaluateStreamingProfile(webmProbe);
    expect(result.needsOptimization).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.some((r) => r.includes("webm"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("vp9"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("opus"))).toBe(true);
  });

  it("requires optimization when missing faststart", () => {
    const noFaststartProbe: VideoProbeResult = {
      ...compatibleProbe,
      hasFastStart: false,
    };
    const result = evaluateStreamingProfile(noFaststartProbe);
    expect(result.needsOptimization).toBe(true);
    expect(result.reasons.some((r) => r.includes("faststart"))).toBe(true);
  });

  it("requires optimization for resolution over 1080p", () => {
    const highResProbe: VideoProbeResult = {
      ...compatibleProbe,
      height: 2160,
    };
    const result = evaluateStreamingProfile(highResProbe);
    expect(result.needsOptimization).toBe(true);
    expect(result.reasons.some((r) => r.includes("2160"))).toBe(true);
  });

  it("requires optimization for excessive bitrate", () => {
    const highBitrateProbe: VideoProbeResult = {
      ...compatibleProbe,
      videoBitrateKbps: 15000,
    };
    const result = evaluateStreamingProfile(highBitrateProbe);
    expect(result.needsOptimization).toBe(true);
    expect(result.reasons.some((r) => r.includes("Bitrate"))).toBe(true);
  });

  it("accepts H.264 variant codecs (AVC)", () => {
    const avcProbe: VideoProbeResult = {
      ...compatibleProbe,
      videoCodec: "avc1",
    };
    const result = evaluateStreamingProfile(avcProbe);
    expect(result.needsOptimization).toBe(false);
  });

  it("accepts MOV container as compatible", () => {
    const movProbe: VideoProbeResult = {
      ...compatibleProbe,
      containerFormat: "mov,mp4,m4a,3gp,3g2,mj2",
    };
    const result = evaluateStreamingProfile(movProbe);
    expect(result.needsOptimization).toBe(false);
  });
});

describe("filterSlideTimestamps", () => {
  it("filters out invalid timestamps", () => {
    const timestamps = [-5, 0, 10, NaN, 50, Infinity, 100];
    const filtered = filterSlideTimestamps(timestamps, 120);
    expect(filtered).toEqual([0, 10, 50, 100]);
  });

  it("removes timestamps beyond duration", () => {
    const timestamps = [0, 30, 60, 90, 120, 150];
    const filtered = filterSlideTimestamps(timestamps, 100);
    expect(filtered).toEqual([0, 30, 60, 90]);
  });

  it("deduplicates timestamps within tolerance", () => {
    const timestamps = [0, 0.3, 10, 10.2, 10.4, 20];
    const filtered = filterSlideTimestamps(timestamps, 100);
    expect(filtered).toEqual([0, 10, 20]);
  });

  it("sorts timestamps", () => {
    const timestamps = [60, 10, 30, 0, 90];
    const filtered = filterSlideTimestamps(timestamps, 100);
    expect(filtered).toEqual([0, 10, 30, 60, 90]);
  });
});

describe("resolveSlideNavigation", () => {
  const slides: SlideMarker[] = [
    { id: "s0", index: 0, timeSeconds: 0, title: null, source: "auto" },
    { id: "s1", index: 1, timeSeconds: 30, title: null, source: "auto" },
    { id: "s2", index: 2, timeSeconds: 60, title: null, source: "auto" },
    { id: "s3", index: 3, timeSeconds: 90, title: null, source: "auto" },
  ];
  const duration = 120;

  describe("prev navigation", () => {
    it("restarts current slide when >4s into it", () => {
      const result = resolveSlideNavigation(35, "prev", slides, duration);
      expect(result.action).toBe("restart");
      expect(result.targetTime).toBe(30);
    });

    it("goes to previous slide when <=4s into current", () => {
      const result = resolveSlideNavigation(32, "prev", slides, duration);
      expect(result.action).toBe("previous");
      expect(result.targetTime).toBe(0);
    });

    it("restarts first slide when at beginning", () => {
      const result = resolveSlideNavigation(2, "prev", slides, duration);
      expect(result.action).toBe("restart");
      expect(result.targetTime).toBe(0);
    });

    it("uses threshold constant correctly", () => {
      const atThreshold = 30 + SLIDE_RESTART_THRESHOLD_SECONDS;
      const result = resolveSlideNavigation(atThreshold, "prev", slides, duration);
      expect(result.action).toBe("previous");
      expect(result.targetTime).toBe(0);

      const pastThreshold = 30 + SLIDE_RESTART_THRESHOLD_SECONDS + 0.1;
      const result2 = resolveSlideNavigation(pastThreshold, "prev", slides, duration);
      expect(result2.action).toBe("restart");
      expect(result2.targetTime).toBe(30);
    });
  });

  describe("next navigation", () => {
    it("goes to next slide when available", () => {
      const result = resolveSlideNavigation(35, "next", slides, duration);
      expect(result.action).toBe("next");
      expect(result.targetTime).toBe(60);
    });

    it("returns none action at last slide", () => {
      const result = resolveSlideNavigation(95, "next", slides, duration);
      expect(result.action).toBe("none");
    });
  });

  describe("empty slides", () => {
    it("returns start for prev with no slides", () => {
      const result = resolveSlideNavigation(50, "prev", [], duration);
      expect(result.action).toBe("none");
      expect(result.targetTime).toBe(0);
    });

    it("returns end for next with no slides", () => {
      const result = resolveSlideNavigation(50, "next", [], duration);
      expect(result.action).toBe("none");
      expect(result.targetTime).toBe(duration);
    });
  });
});

describe("simplifyAccessPolicyForAdmin", () => {
  it("maps SINGLE_VIEW_WITH_EXPIRATION to SINGLE_VIEW", () => {
    expect(simplifyAccessPolicyForAdmin(ACCESS_POLICY.SINGLE_VIEW_WITH_EXPIRATION)).toBe(
      ACCESS_POLICY.SINGLE_VIEW,
    );
  });

  it("preserves SINGLE_VIEW", () => {
    expect(simplifyAccessPolicyForAdmin(ACCESS_POLICY.SINGLE_VIEW)).toBe(
      ACCESS_POLICY.SINGLE_VIEW,
    );
  });

  it("preserves TIME_LIMITED", () => {
    expect(simplifyAccessPolicyForAdmin(ACCESS_POLICY.TIME_LIMITED)).toBe(
      ACCESS_POLICY.TIME_LIMITED,
    );
  });

  it("handles null/undefined as SINGLE_VIEW", () => {
    expect(simplifyAccessPolicyForAdmin(null)).toBe(ACCESS_POLICY.SINGLE_VIEW);
    expect(simplifyAccessPolicyForAdmin(undefined)).toBe(ACCESS_POLICY.SINGLE_VIEW);
  });
});
