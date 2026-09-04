import { describe, expect, it } from "vitest";
import {
  VIDEO_PROCESSING_FAILURE_CATEGORY,
  VIDEO_PROCESSING_HISTORY_MAX,
  VIDEO_PROCESSING_STALE_MS,
  appendProcessingHistory,
  classifyProcessingAbandonment,
  estimateRemainingSeconds,
  formatElapsedLabel,
  formatLastActivityAgo,
  formatMediaClock,
} from "../../packages/shared/src/videoProcessing";
import { isVideoProcessingStale } from "../../functions/src/lib/videoLifecycle.pure";
import { VIDEO_PROCESSING_STATUS } from "../../packages/shared/src";

describe("formatMediaClock", () => {
  it("formats mm:ss and h:mm:ss", () => {
    expect(formatMediaClock(0)).toBe("0:00");
    expect(formatMediaClock(851)).toBe("14:11");
    expect(formatMediaClock(1351)).toBe("22:31");
    expect(formatMediaClock(3723)).toBe("1:02:03");
  });
});

describe("estimateRemainingSeconds", () => {
  it("returns null until enough trustworthy progress exists", () => {
    expect(
      estimateRemainingSeconds({
        processedSeconds: 10,
        totalSeconds: 1300,
        encodeElapsedSeconds: 30,
      }),
    ).toBeNull();
  });

  it("estimates remaining from observed rate", () => {
    const eta = estimateRemainingSeconds({
      processedSeconds: 300,
      totalSeconds: 1300,
      encodeElapsedSeconds: 900,
    });
    expect(eta).toBeTypeOf("number");
    expect(eta!).toBeGreaterThan(1000);
    expect(eta!).toBeLessThan(5000);
  });

  it("omits unstable / extreme rates", () => {
    expect(
      estimateRemainingSeconds({
        processedSeconds: 100,
        totalSeconds: 1300,
        encodeElapsedSeconds: 5,
      }),
    ).toBeNull();
  });
});

describe("appendProcessingHistory", () => {
  it("trims to retention limit", () => {
    const entries = Array.from({ length: VIDEO_PROCESSING_HISTORY_MAX + 3 }, (_, i) => ({
      attempt: i + 1,
      outcome: "failed" as const,
    }));
    const trimmed = appendProcessingHistory([], entries[0]!);
    let hist = trimmed;
    for (let i = 1; i < entries.length; i++) {
      hist = appendProcessingHistory(hist, entries[i]!);
    }
    expect(hist).toHaveLength(VIDEO_PROCESSING_HISTORY_MAX);
    expect(hist[0]?.attempt).toBe(4);
    expect(hist[hist.length - 1]?.attempt).toBe(VIDEO_PROCESSING_HISTORY_MAX + 3);
  });
});

describe("classifyProcessingAbandonment", () => {
  const now = new Date("2026-08-24T12:00:00.000Z").getTime();

  it("classifies hard timeout vs stall", () => {
    expect(
      classifyProcessingAbandonment({
        startedAt: "2026-08-24T08:00:00.000Z",
        lastProgressAt: "2026-08-24T11:55:00.000Z",
        nowMs: now,
      }),
    ).toBe(VIDEO_PROCESSING_FAILURE_CATEGORY.PROCESSING_TIMEOUT);

    expect(
      classifyProcessingAbandonment({
        startedAt: "2026-08-24T11:00:00.000Z",
        lastProgressAt: "2026-08-24T11:40:00.000Z",
        nowMs: now,
      }),
    ).toBe(VIDEO_PROCESSING_FAILURE_CATEGORY.PROCESSING_STALLED);
  });
});

describe("stall threshold (10 minutes)", () => {
  const now = new Date("2026-08-24T12:00:00.000Z").getTime();

  it("does not treat long encodes with fresh heartbeats as stalled", () => {
    expect(
      isVideoProcessingStale(
        {
          status: VIDEO_PROCESSING_STATUS.OPTIMIZING,
          startedAt: "2026-08-24T10:00:00.000Z",
          lastProgressAt: "2026-08-24T11:55:00.000Z",
        },
        now,
      ),
    ).toBe(false);
  });

  it("treats ~10+ minutes without progress as stalled", () => {
    expect(
      isVideoProcessingStale(
        {
          status: VIDEO_PROCESSING_STATUS.OPTIMIZING,
          startedAt: "2026-08-24T11:00:00.000Z",
          lastProgressAt: "2026-08-24T11:49:00.000Z",
        },
        now,
        VIDEO_PROCESSING_STALE_MS,
      ),
    ).toBe(true);
  });

  it("keeps 9-minute silence as not stale", () => {
    expect(
      isVideoProcessingStale(
        {
          status: VIDEO_PROCESSING_STATUS.OPTIMIZING,
          startedAt: "2026-08-24T11:00:00.000Z",
          lastProgressAt: "2026-08-24T11:51:00.000Z",
        },
        now,
        VIDEO_PROCESSING_STALE_MS,
      ),
    ).toBe(false);
  });
});

describe("format helpers", () => {
  it("formats elapsed and last-activity labels", () => {
    expect(formatElapsedLabel(52 * 60_000)).toBe("52 minutes");
    expect(
      formatLastActivityAgo("2026-08-24T11:59:52.000Z", new Date("2026-08-24T12:00:00.000Z").getTime()),
    ).toBe("8 seconds ago");
  });
});
