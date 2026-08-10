import { VIEWING_LEASE_STATUS } from "../shared";

export interface LeaseSnapshot {
  deviceId: string;
  status: string;
  leaseExpiresAt: string;
  closed?: boolean;
}

/** Pure lease activity check — unit tested without Firestore. */
export function isLeaseActivePure(
  lease: LeaseSnapshot | null | undefined,
  nowMs: number,
): boolean {
  if (!lease) return false;
  if (lease.closed) return false;
  if (lease.status === VIEWING_LEASE_STATUS.CONSUMED) return false;
  if (lease.status !== VIEWING_LEASE_STATUS.ACTIVE) return false;
  return new Date(lease.leaseExpiresAt).getTime() > nowMs;
}

export function canDeviceAccessLease(
  lease: LeaseSnapshot | null | undefined,
  deviceId: string,
  nowMs: number,
): { ok: true } | { ok: false; reason: string } {
  if (!lease) return { ok: true };
  if (lease.status === VIEWING_LEASE_STATUS.CONSUMED || lease.closed) {
    return { ok: false, reason: "consumed" };
  }
  if (isLeaseActivePure(lease, nowMs) && lease.deviceId !== deviceId) {
    return { ok: false, reason: "other_device" };
  }
  return { ok: true };
}

export function isUsablePublishedContent(data: {
  status?: string;
  isPlaceholder?: boolean;
} | null): boolean {
  if (!data) return false;
  if (data.status !== "active") return false;
  if (data.isPlaceholder === true) return false;
  return true;
}
