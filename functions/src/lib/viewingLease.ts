import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  VIEWING_LEASE_STATUS,
  VIEWING_LEASE_TTL_MS,
  isConsumedStatus,
  type SessionStatus,
} from "../shared";
import { db } from "./firebase";
import { isLeaseActivePure } from "./viewingLease.pure";
import {
  genericAccessUnavailableMessage,
  sessionSingleViewBlocked,
} from "./presentationPolicy";

export interface LeaseDoc {
  sessionId: string;
  deviceId: string;
  status: string;
  acquiredAt: string;
  leaseExpiresAt: string;
  lastHeartbeatAt: string;
  meaningfulPlaybackStarted: boolean;
  closed?: boolean;
}

export function leaseCollection() {
  return db.collection("viewingLeases");
}

export function isLeaseActive(
  lease: LeaseDoc | null | undefined,
  nowMs = Date.now(),
): boolean {
  return isLeaseActivePure(lease, nowMs);
}

export function assertSessionAccessible(session: Record<string, unknown>): void {
  if (sessionSingleViewBlocked(session)) {
    throw new HttpsError(
      "failed-precondition",
      genericAccessUnavailableMessage(),
    );
  }
}

export function assertSessionNotConsumed(status: SessionStatus): void {
  if (isConsumedStatus(status)) {
    throw new HttpsError(
      "failed-precondition",
      genericAccessUnavailableMessage(),
    );
  }
}

/**
 * Ensures this device may hold / renew the viewing lease.
 * Expired leases can be reacquired (crash recovery) — that does not consume the viewing.
 * Active lease on another device blocks access.
 */
export async function assertLeaseAllowsDevice(
  sessionId: string,
  deviceId: string,
  options: { requireActiveLease: boolean },
): Promise<LeaseDoc | null> {
  const snap = await leaseCollection().doc(sessionId).get();
  if (!snap.exists) {
    if (options.requireActiveLease) {
      throw new HttpsError(
        "failed-precondition",
        "No active viewing lease. Start playback to begin your viewing session.",
      );
    }
    return null;
  }
  const lease = snap.data() as LeaseDoc;
  if (lease.status === VIEWING_LEASE_STATUS.CONSUMED || lease.closed) {
    throw new HttpsError(
      "failed-precondition",
      "This presentation has already been viewed. Please contact your representative.",
    );
  }

  const active = isLeaseActive(lease);
  if (active && lease.deviceId !== deviceId) {
    throw new HttpsError(
      "failed-precondition",
      "This presentation is already being viewed on another device.",
    );
  }

  if (options.requireActiveLease && !active) {
    throw new HttpsError(
      "failed-precondition",
      "Viewing lease expired. Resume playback to reclaim the lease, or ask your representative to reset an interrupted session.",
    );
  }

  if (options.requireActiveLease && lease.deviceId !== deviceId) {
    throw new HttpsError(
      "failed-precondition",
      "This presentation is already being viewed on another device.",
    );
  }

  return lease;
}

export async function acquireOrRenewLease(input: {
  sessionId: string;
  deviceId: string;
  userAgent?: string;
  ipAddress?: string;
}): Promise<{ lease: LeaseDoc; created: boolean }> {
  const ref = leaseCollection().doc(input.sessionId);
  const now = Date.now();
  const expiresAt = new Date(now + VIEWING_LEASE_TTL_MS).toISOString();
  const nowIso = new Date(now).toISOString();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const existing = snap.data() as LeaseDoc;
      if (
        existing.status === VIEWING_LEASE_STATUS.CONSUMED ||
        existing.closed
      ) {
        throw new HttpsError(
          "failed-precondition",
          "This presentation has already been viewed. Please contact your representative.",
        );
      }
      if (isLeaseActive(existing, now) && existing.deviceId !== input.deviceId) {
        throw new HttpsError(
          "failed-precondition",
          "This presentation is already being viewed on another device.",
        );
      }

      const created = !isLeaseActive(existing, now);
      const lease: LeaseDoc = {
        sessionId: input.sessionId,
        deviceId: input.deviceId,
        status: VIEWING_LEASE_STATUS.ACTIVE,
        acquiredAt: created ? nowIso : existing.acquiredAt,
        leaseExpiresAt: expiresAt,
        lastHeartbeatAt: nowIso,
        meaningfulPlaybackStarted: true,
      };
      tx.set(
        ref,
        {
          ...lease,
          userAgent: input.userAgent ?? null,
          ipAddress: input.ipAddress ?? null,
          updatedAtServer: FieldValue.serverTimestamp(),
          leaseExpiresAtServer: Timestamp.fromMillis(now + VIEWING_LEASE_TTL_MS),
        },
        { merge: true },
      );
      return { lease, created };
    }

    const lease: LeaseDoc = {
      sessionId: input.sessionId,
      deviceId: input.deviceId,
      status: VIEWING_LEASE_STATUS.ACTIVE,
      acquiredAt: nowIso,
      leaseExpiresAt: expiresAt,
      lastHeartbeatAt: nowIso,
      meaningfulPlaybackStarted: true,
    };
    tx.set(ref, {
      ...lease,
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
      createdAtServer: FieldValue.serverTimestamp(),
      updatedAtServer: FieldValue.serverTimestamp(),
      leaseExpiresAtServer: Timestamp.fromMillis(now + VIEWING_LEASE_TTL_MS),
    });
    return { lease, created: true };
  });
}

export async function renewLease(
  sessionId: string,
  deviceId: string,
): Promise<LeaseDoc> {
  const { lease } = await acquireOrRenewLease({ sessionId, deviceId });
  if (lease.deviceId !== deviceId) {
    throw new HttpsError(
      "failed-precondition",
      "This presentation is already being viewed on another device.",
    );
  }
  return lease;
}

export async function markLeaseConsumed(sessionId: string): Promise<void> {
  await leaseCollection().doc(sessionId).set(
    {
      status: VIEWING_LEASE_STATUS.CONSUMED,
      closed: true,
      closedAt: new Date().toISOString(),
      closedAtServer: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

export async function clearInterruptedLease(sessionId: string): Promise<void> {
  const ref = leaseCollection().doc(sessionId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const lease = snap.data() as LeaseDoc;
  if (lease.status === VIEWING_LEASE_STATUS.CONSUMED || lease.closed) {
    throw new HttpsError(
      "failed-precondition",
      "Completed sessions cannot be reset. Create a new invitation instead.",
    );
  }
  await ref.set(
    {
      status: VIEWING_LEASE_STATUS.RELEASED,
      deviceId: null,
      leaseExpiresAt: new Date(0).toISOString(),
      releasedAt: new Date().toISOString(),
      meaningfulPlaybackStarted: false,
      updatedAtServer: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}
