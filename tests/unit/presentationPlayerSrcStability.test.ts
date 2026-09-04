import { describe, expect, it } from "vitest";
import {
  shouldApplyLeaseVideoUrl,
  shouldStartLeaseAcquire,
} from "../../src/modules/video/presentationPlayer.pure";

describe("shouldApplyLeaseVideoUrl", () => {
  it("never replaces an existing grantVideoAccess src with a lease URL", () => {
    expect(
      shouldApplyLeaseVideoUrl({
        existingSrc: "https://storage.example/signed-from-grant",
        leaseVideoUrl: "https://storage.example/signed-from-lease",
      }),
    ).toBe(false);
  });

  it("allows lease URL only when no src exists yet", () => {
    expect(
      shouldApplyLeaseVideoUrl({
        existingSrc: null,
        leaseVideoUrl: "https://storage.example/signed-from-lease",
      }),
    ).toBe(true);
  });

  it("ignores empty lease URLs", () => {
    expect(
      shouldApplyLeaseVideoUrl({
        existingSrc: null,
        leaseVideoUrl: "",
      }),
    ).toBe(false);
  });
});

describe("shouldStartLeaseAcquire", () => {
  it("blocks concurrent and already-acquired calls", () => {
    expect(
      shouldStartLeaseAcquire({
        alreadyAcquired: true,
        inFlight: false,
        currentTimeSeconds: 5,
        meaningfulPlaybackSeconds: 1,
      }),
    ).toBe(false);
    expect(
      shouldStartLeaseAcquire({
        alreadyAcquired: false,
        inFlight: true,
        currentTimeSeconds: 5,
        meaningfulPlaybackSeconds: 1,
      }),
    ).toBe(false);
  });

  it("starts only after meaningful playback threshold", () => {
    expect(
      shouldStartLeaseAcquire({
        alreadyAcquired: false,
        inFlight: false,
        currentTimeSeconds: 0.5,
        meaningfulPlaybackSeconds: 1,
      }),
    ).toBe(false);
    expect(
      shouldStartLeaseAcquire({
        alreadyAcquired: false,
        inFlight: false,
        currentTimeSeconds: 1,
        meaningfulPlaybackSeconds: 1,
      }),
    ).toBe(true);
  });
});
