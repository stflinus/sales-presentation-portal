/**
 * Pure helpers for diagnosing client playback asset vs admin source preview.
 */

export function resolveClientPlaybackStoragePath(video: {
  playbackStoragePath?: string | null;
  optimizedStoragePath?: string | null;
  storagePath?: string | null;
}): string | null {
  return (
    String(video.playbackStoragePath || "").trim() ||
    String(video.optimizedStoragePath || "").trim() ||
    String(video.storagePath || "").trim() ||
    null
  );
}

/** Evidence that an "optimized" asset is larger than source (bitrate inflation). */
export function isOptimizedLargerThanSource(input: {
  sourceBytes: number | null | undefined;
  optimizedBytes: number | null | undefined;
}): boolean {
  const s = Number(input.sourceBytes);
  const o = Number(input.optimizedBytes);
  if (!Number.isFinite(s) || !Number.isFinite(o) || s <= 0 || o <= 0) return false;
  return o > s;
}

/** Pathological frame rates (e.g. WebM timestamp artifacts → 1000 fps). */
export function isPathologicalFrameRate(
  frameRate: number | null | undefined,
): boolean {
  if (frameRate == null || !Number.isFinite(frameRate)) return false;
  return frameRate > 120;
}
