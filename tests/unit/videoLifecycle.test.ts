import { describe, expect, it } from "vitest";
import {
  computeScheduledDeletionAt,
  daysRemainingUntilDeletion,
  isVideoProcessingStale,
  sessionBlocksVideoDeletion,
  videoHasActiveProcessingJob,
  videoNeedsOptimizationQueue,
} from "../../functions/src/lib/videoLifecycle.pure";
import {
  ACCESS_POLICY,
  VIDEO_ARCHIVE_RECOVERY_MS,
  VIDEO_PROCESSING_STATUS,
  videoProcessingStatusLabel,
} from "../../packages/shared/src";

describe("computeScheduledDeletionAt", () => {
  it("computes deletion 30 days after archive", () => {
    const archivedAt = "2026-08-01T12:00:00.000Z";
    const scheduled = computeScheduledDeletionAt(archivedAt);
    // 30 days = 30 * 24 * 60 * 60 * 1000 = 2592000000 ms
    const expectedMs = new Date(archivedAt).getTime() + VIDEO_ARCHIVE_RECOVERY_MS;
    expect(new Date(scheduled).getTime()).toBe(expectedMs);
  });

  it("uses default 30-day recovery period", () => {
    const archivedAt = "2026-08-15T00:00:00.000Z";
    const scheduled = computeScheduledDeletionAt(archivedAt);
    const scheduledDate = new Date(scheduled);
    const archivedDate = new Date(archivedAt);
    const diffDays = (scheduledDate.getTime() - archivedDate.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBe(30);
  });

  it("allows custom recovery period", () => {
    const archivedAt = "2026-08-01T00:00:00.000Z";
    const customRecoveryMs = 7 * 24 * 60 * 60 * 1000; // 7 days
    const scheduled = computeScheduledDeletionAt(archivedAt, customRecoveryMs);
    const expectedDate = new Date(new Date(archivedAt).getTime() + customRecoveryMs);
    expect(scheduled).toBe(expectedDate.toISOString());
  });
});

describe("daysRemainingUntilDeletion", () => {
  const baseTime = new Date("2026-08-23T12:00:00.000Z").getTime();

  it("returns null for null/undefined scheduled date", () => {
    expect(daysRemainingUntilDeletion(null, baseTime)).toBeNull();
    expect(daysRemainingUntilDeletion(undefined, baseTime)).toBeNull();
  });

  it("returns 0 when scheduled time is past", () => {
    const pastDate = "2026-08-20T12:00:00.000Z";
    expect(daysRemainingUntilDeletion(pastDate, baseTime)).toBe(0);
  });

  it("returns 0 when scheduled time equals now", () => {
    const nowDate = "2026-08-23T12:00:00.000Z";
    expect(daysRemainingUntilDeletion(nowDate, baseTime)).toBe(0);
  });

  it("returns correct days remaining for future date", () => {
    // 7 days in the future
    const futureDate = "2026-08-30T12:00:00.000Z";
    expect(daysRemainingUntilDeletion(futureDate, baseTime)).toBe(7);
  });

  it("rounds up partial days", () => {
    // 1.5 days in the future should return 2
    const futureDate = new Date(baseTime + 1.5 * 24 * 60 * 60 * 1000).toISOString();
    expect(daysRemainingUntilDeletion(futureDate, baseTime)).toBe(2);
  });

  it("handles 1 day remaining", () => {
    const futureDate = new Date(baseTime + 24 * 60 * 60 * 1000).toISOString();
    expect(daysRemainingUntilDeletion(futureDate, baseTime)).toBe(1);
  });
});

describe("sessionBlocksVideoDeletion", () => {
  const nowMs = new Date("2026-08-23T12:00:00.000Z").getTime();

  describe("time-limited policy", () => {
    it("blocks if expiresAt is in the future", () => {
      const session = {
        status: "in_progress",
        accessPolicy: ACCESS_POLICY.TIME_LIMITED,
        expiresAt: "2026-08-30T12:00:00.000Z",
      };
      expect(sessionBlocksVideoDeletion(session, nowMs)).toBe(true);
    });

    it("does not block if expiresAt is in the past", () => {
      const session = {
        status: "in_progress",
        accessPolicy: ACCESS_POLICY.TIME_LIMITED,
        expiresAt: "2026-08-20T12:00:00.000Z",
      };
      expect(sessionBlocksVideoDeletion(session, nowMs)).toBe(false);
    });

    it("blocks even for completed status if not yet expired", () => {
      const session = {
        status: "completed",
        accessPolicy: ACCESS_POLICY.TIME_LIMITED,
        expiresAt: "2026-08-30T12:00:00.000Z",
      };
      expect(sessionBlocksVideoDeletion(session, nowMs)).toBe(true);
    });
  });

  describe("single-view policy", () => {
    it("blocks if not consumed and status is not terminal", () => {
      const session = {
        status: "in_progress",
        accessPolicy: ACCESS_POLICY.SINGLE_VIEW,
        viewingEntitlementConsumed: false,
      };
      expect(sessionBlocksVideoDeletion(session, nowMs)).toBe(true);
    });

    it("does not block if entitlement is consumed", () => {
      const session = {
        status: "completed",
        accessPolicy: ACCESS_POLICY.SINGLE_VIEW,
        viewingEntitlementConsumed: true,
      };
      expect(sessionBlocksVideoDeletion(session, nowMs)).toBe(false);
    });

    it("does not block if status is completed", () => {
      const session = {
        status: "completed",
        accessPolicy: ACCESS_POLICY.SINGLE_VIEW,
        viewingEntitlementConsumed: false,
      };
      expect(sessionBlocksVideoDeletion(session, nowMs)).toBe(false);
    });

    it("does not block if status is closed", () => {
      const session = {
        status: "closed",
        accessPolicy: ACCESS_POLICY.SINGLE_VIEW,
        viewingEntitlementConsumed: false,
      };
      expect(sessionBlocksVideoDeletion(session, nowMs)).toBe(false);
    });

    it("does not block if status is revoked", () => {
      const session = {
        status: "revoked",
        accessPolicy: ACCESS_POLICY.SINGLE_VIEW,
        viewingEntitlementConsumed: false,
      };
      expect(sessionBlocksVideoDeletion(session, nowMs)).toBe(false);
    });

    it("does not block if status is expired", () => {
      const session = {
        status: "expired",
        accessPolicy: ACCESS_POLICY.SINGLE_VIEW,
        viewingEntitlementConsumed: false,
      };
      expect(sessionBlocksVideoDeletion(session, nowMs)).toBe(false);
    });

    it("blocks if status is pending", () => {
      const session = {
        status: "pending",
        accessPolicy: ACCESS_POLICY.SINGLE_VIEW,
        viewingEntitlementConsumed: false,
      };
      expect(sessionBlocksVideoDeletion(session, nowMs)).toBe(true);
    });
  });
});

describe("videoNeedsOptimizationQueue", () => {
  it("returns false when no storagePath", () => {
    expect(videoNeedsOptimizationQueue({ storagePath: null })).toBe(false);
    expect(videoNeedsOptimizationQueue({ storagePath: undefined })).toBe(false);
    expect(videoNeedsOptimizationQueue({ storagePath: "" })).toBe(false);
  });

  it("returns false when deleted", () => {
    expect(videoNeedsOptimizationQueue({
      storagePath: "videos/123/source.mp4",
      deleted: true,
    })).toBe(false);
  });

  it("returns false when tombstone", () => {
    expect(videoNeedsOptimizationQueue({
      storagePath: "videos/123/source.mp4",
      tombstone: true,
    })).toBe(false);
  });

  it("returns false when permanently deleted", () => {
    expect(videoNeedsOptimizationQueue({
      storagePath: "videos/123/source.mp4",
      permanentlyDeletedAt: "2026-08-01T00:00:00.000Z",
    })).toBe(false);
  });

  it("returns false when archived", () => {
    expect(videoNeedsOptimizationQueue({
      storagePath: "videos/123/source.mp4",
      archived: true,
    })).toBe(false);
    expect(videoNeedsOptimizationQueue({
      storagePath: "videos/123/source.mp4",
      status: "archived",
    })).toBe(false);
  });

  it("returns true when no processing state", () => {
    expect(videoNeedsOptimizationQueue({
      storagePath: "videos/123/source.mp4",
    })).toBe(true);
    expect(videoNeedsOptimizationQueue({
      storagePath: "videos/123/source.mp4",
      processing: null,
    })).toBe(true);
  });

  it("returns true when processing status is failed", () => {
    expect(videoNeedsOptimizationQueue({
      storagePath: "videos/123/source.mp4",
      processing: { status: VIDEO_PROCESSING_STATUS.FAILED },
    })).toBe(true);
  });

  it("returns false when processing status is ready", () => {
    expect(videoNeedsOptimizationQueue({
      storagePath: "videos/123/source.mp4",
      processing: { status: VIDEO_PROCESSING_STATUS.READY },
    })).toBe(false);
  });

  it("returns false when processing status is skipped_compatible", () => {
    expect(videoNeedsOptimizationQueue({
      storagePath: "videos/123/source.mp4",
      processing: { status: VIDEO_PROCESSING_STATUS.SKIPPED_COMPATIBLE },
    })).toBe(false);
  });

  it("returns false when processing is in progress (analyzing)", () => {
    expect(videoNeedsOptimizationQueue({
      storagePath: "videos/123/source.mp4",
      processing: { status: VIDEO_PROCESSING_STATUS.ANALYZING },
    })).toBe(false);
  });

  it("returns false when processing is in progress (optimizing)", () => {
    expect(videoNeedsOptimizationQueue({
      storagePath: "videos/123/source.mp4",
      processing: { status: VIDEO_PROCESSING_STATUS.OPTIMIZING },
    })).toBe(false);
  });
});

describe("isVideoProcessingStale", () => {
  const now = new Date("2026-08-24T12:00:00.000Z").getTime();

  it("returns false for ready/failed", () => {
    expect(
      isVideoProcessingStale(
        { status: VIDEO_PROCESSING_STATUS.READY, lastProgressAt: "2026-08-23T00:00:00.000Z" },
        now,
      ),
    ).toBe(false);
  });

  it("returns true when optimizing with stale heartbeat", () => {
    expect(
      isVideoProcessingStale(
        {
          status: VIDEO_PROCESSING_STATUS.OPTIMIZING,
          startedAt: "2026-08-23T23:00:00.000Z",
          lastProgressAt: "2026-08-23T23:05:00.000Z",
        },
        now,
      ),
    ).toBe(true);
  });

  it("returns false when recent heartbeat exists", () => {
    expect(
      isVideoProcessingStale(
        {
          status: VIDEO_PROCESSING_STATUS.OPTIMIZING,
          startedAt: "2026-08-24T11:50:00.000Z",
          lastProgressAt: "2026-08-24T11:55:00.000Z",
        },
        now,
      ),
    ).toBe(false);
  });
});

describe("videoHasActiveProcessingJob", () => {
  it("returns false when no processing state", () => {
    expect(videoHasActiveProcessingJob({})).toBe(false);
  });

  it("returns true for in-flight statuses", () => {
    expect(
      videoHasActiveProcessingJob({
        processing: { status: VIDEO_PROCESSING_STATUS.OPTIMIZING },
      }),
    ).toBe(true);
    expect(
      videoHasActiveProcessingJob({
        processing: { status: VIDEO_PROCESSING_STATUS.ANALYZING },
      }),
    ).toBe(true);
  });

  it("returns false when cancelled even if status is in-flight", () => {
    expect(
      videoHasActiveProcessingJob({
        processing: {
          status: VIDEO_PROCESSING_STATUS.OPTIMIZING,
          cancelled: true,
        },
      }),
    ).toBe(false);
  });

  it("returns false for terminal statuses", () => {
    expect(
      videoHasActiveProcessingJob({
        processing: { status: VIDEO_PROCESSING_STATUS.READY },
      }),
    ).toBe(false);
    expect(
      videoHasActiveProcessingJob({
        processing: { status: VIDEO_PROCESSING_STATUS.FAILED },
      }),
    ).toBe(false);
  });
});

describe("videoProcessingStatusLabel", () => {
  it("returns 'Not Analyzed' for null/undefined", () => {
    expect(videoProcessingStatusLabel(null)).toBe("Not Analyzed");
    expect(videoProcessingStatusLabel(undefined)).toBe("Not Analyzed");
  });

  it("returns 'Ready / Optimized' for ready status", () => {
    expect(videoProcessingStatusLabel(VIDEO_PROCESSING_STATUS.READY)).toBe("Ready / Optimized");
  });

  it("returns 'Ready / Already Compatible' for skipped_compatible", () => {
    expect(videoProcessingStatusLabel(VIDEO_PROCESSING_STATUS.SKIPPED_COMPATIBLE)).toBe("Ready / Already Compatible");
  });

  it("returns 'Processing Failed' for failed status", () => {
    expect(videoProcessingStatusLabel(VIDEO_PROCESSING_STATUS.FAILED)).toBe("Processing Failed");
  });

  it("returns appropriate labels for processing stages", () => {
    expect(videoProcessingStatusLabel(VIDEO_PROCESSING_STATUS.ANALYZING)).toBe("Analyzing");
    expect(videoProcessingStatusLabel(VIDEO_PROCESSING_STATUS.OPTIMIZING)).toBe("Optimizing");
    expect(videoProcessingStatusLabel(VIDEO_PROCESSING_STATUS.DETECTING_SLIDES)).toBe("Detecting Slides");
    expect(videoProcessingStatusLabel(VIDEO_PROCESSING_STATUS.VERIFYING)).toBe("Verifying");
  });
});

describe("processing isolation", () => {
  it("videoNeedsOptimizationQueue does not touch session fields", () => {
    // This test documents that queueing only checks video.processing,
    // never session accessPolicy/expiresAt/viewerAuth.
    // The function signature proves this - it only takes video properties.
    const video = {
      storagePath: "videos/123/source.mp4",
      processing: { status: VIDEO_PROCESSING_STATUS.FAILED },
    };
    
    // The function should work without any session-related fields
    expect(videoNeedsOptimizationQueue(video)).toBe(true);
    
    // Adding unrelated fields doesn't change behavior
    const videoWithExtra = {
      ...video,
      someSessionField: "should be ignored",
    };
    expect(videoNeedsOptimizationQueue(videoWithExtra)).toBe(true);
  });
});
