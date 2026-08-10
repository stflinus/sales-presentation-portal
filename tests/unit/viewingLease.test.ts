import { describe, expect, it } from "vitest";
import {
  canDeviceAccessLease,
  isLeaseActivePure,
  isUsablePublishedContent,
} from "../../functions/src/lib/viewingLease.pure";

describe("viewing lease semantics", () => {
  const now = Date.parse("2026-08-02T20:00:00.000Z");

  it("treats missing lease as inactive (opening/legal/load do not consume)", () => {
    expect(isLeaseActivePure(null, now)).toBe(false);
    expect(canDeviceAccessLease(null, "device-a", now)).toEqual({ ok: true });
  });

  it("allows same device while lease active", () => {
    const lease = {
      deviceId: "device-a",
      status: "active",
      leaseExpiresAt: "2026-08-02T20:01:00.000Z",
    };
    expect(isLeaseActivePure(lease, now)).toBe(true);
    expect(canDeviceAccessLease(lease, "device-a", now)).toEqual({ ok: true });
  });

  it("blocks second device while lease active", () => {
    const lease = {
      deviceId: "device-a",
      status: "active",
      leaseExpiresAt: "2026-08-02T20:01:00.000Z",
    };
    expect(canDeviceAccessLease(lease, "device-b", now)).toEqual({
      ok: false,
      reason: "other_device",
    });
  });

  it("allows reclaim after lease expiry (crash recovery, not consumed)", () => {
    const lease = {
      deviceId: "device-a",
      status: "active",
      leaseExpiresAt: "2026-08-02T19:59:00.000Z",
    };
    expect(isLeaseActivePure(lease, now)).toBe(false);
    expect(canDeviceAccessLease(lease, "device-b", now)).toEqual({ ok: true });
  });

  it("never allows access after consume", () => {
    const lease = {
      deviceId: "device-a",
      status: "consumed",
      leaseExpiresAt: "2026-08-02T20:01:00.000Z",
      closed: true,
    };
    expect(canDeviceAccessLease(lease, "device-a", now)).toEqual({
      ok: false,
      reason: "consumed",
    });
  });
});

describe("published content policy", () => {
  it("rejects placeholders and drafts", () => {
    expect(isUsablePublishedContent({ status: "placeholder", isPlaceholder: true })).toBe(
      false,
    );
    expect(isUsablePublishedContent({ status: "draft", isPlaceholder: false })).toBe(
      false,
    );
    expect(isUsablePublishedContent({ status: "active", isPlaceholder: true })).toBe(
      false,
    );
  });

  it("accepts active non-placeholder content", () => {
    expect(isUsablePublishedContent({ status: "active", isPlaceholder: false })).toBe(
      true,
    );
  });
});
