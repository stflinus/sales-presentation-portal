import { describe, expect, it } from "vitest";
import {
  isOptimizedLargerThanSource,
  isPathologicalFrameRate,
  resolveClientPlaybackStoragePath,
} from "../../src/modules/video/playbackAsset.pure";

describe("client playback asset selection", () => {
  it("prefers playbackStoragePath then optimized then source", () => {
    expect(
      resolveClientPlaybackStoragePath({
        playbackStoragePath: "videos/a/optimized.mp4",
        optimizedStoragePath: "videos/a/optimized.mp4",
        storagePath: "videos/a/source.mp4",
      }),
    ).toBe("videos/a/optimized.mp4");
    expect(
      resolveClientPlaybackStoragePath({
        playbackStoragePath: null,
        optimizedStoragePath: null,
        storagePath: "videos/a/source.mp4",
      }),
    ).toBe("videos/a/source.mp4");
  });

  it("flags Dan-style optimized-larger-than-source inflation", () => {
    expect(
      isOptimizedLargerThanSource({
        sourceBytes: 377853887,
        optimizedBytes: 593662335,
      }),
    ).toBe(true);
    expect(
      isOptimizedLargerThanSource({
        sourceBytes: 500,
        optimizedBytes: 400,
      }),
    ).toBe(false);
  });

  it("flags pathological frame rates that produce over-framed encodes", () => {
    expect(isPathologicalFrameRate(1000)).toBe(true);
    expect(isPathologicalFrameRate(30)).toBe(false);
    expect(isPathologicalFrameRate(60)).toBe(false);
  });
});
