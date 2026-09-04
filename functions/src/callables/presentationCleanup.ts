import * as logger from "firebase-functions/logger";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import type {
  DocumentData,
  QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import {
  PRESENTATION_INACTIVITY_CLEANUP_MS,
  PERMISSIONS,
} from "../shared";
import { assertHasPermission, loadStaffContext } from "../lib/authz";
import { db } from "../lib/firebase";
import {
  evaluatePresentationCleanupEligibility,
  shouldPostponeCleanupForActiveLease,
  type PresentationCleanupReason,
} from "../lib/presentationCleanup.pure";
import { permanentlyDeletePresentationOperational } from "../lib/presentationOperationalDelete";

const BATCH_LIMIT = 200;
const MAX_PAGES = 20;

async function loadInviteHints(inviteId: string | null): Promise<{
  sentAt: string | null;
  openedAt: string | null;
}> {
  if (!inviteId) return { sentAt: null, openedAt: null };
  try {
    const snap = await db.collection("invites").doc(inviteId).get();
    if (!snap.exists) return { sentAt: null, openedAt: null };
    const d = snap.data()!;
    return {
      sentAt: (d.sentAt as string) || null,
      openedAt: (d.openedAt as string) || null,
    };
  } catch {
    return { sentAt: null, openedAt: null };
  }
}

type ProcessResult = "would_delete" | "deleted" | "postponed" | "skipped";

async function processEligibleSession(
  sessionId: string,
  data: DocumentData,
  nowMs: number,
  dryRun: boolean,
): Promise<{
  result: ProcessResult;
  reason: PresentationCleanupReason;
  effectiveLastActivityAt: string | null;
}> {
  const inviteId = String(data.inviteId || "") || null;
  const inviteHints = await loadInviteHints(inviteId);
  const analytics = (data.analytics || {}) as Record<string, unknown>;
  const viewerAuth = (data.viewerAuth || {}) as Record<string, unknown>;

  const evaluation = evaluatePresentationCleanupEligibility({
    expiresAt: (data.expiresAt as string) || null,
    status: (data.status as string) || null,
    lastMeaningfulClientActivityAt:
      (data.lastMeaningfulClientActivityAt as string) || null,
    createdAt: (data.createdAt as string) || null,
    sentAt: inviteHints.sentAt,
    openedAt: inviteHints.openedAt,
    authorizedAt: (viewerAuth.authorizedAt as string) || null,
    invitationOpenedAt: (analytics.invitationOpenedAt as string) || null,
    completedAt: (data.completedAt as string) || null,
    nowMs,
    inactivityMs: PRESENTATION_INACTIVITY_CLEANUP_MS,
  });

  if (!evaluation.eligible) {
    return {
      result: "skipped",
      reason: null,
      effectiveLastActivityAt: evaluation.effectiveLastActivityAt,
    };
  }

  const leaseSnap = await db.collection("viewingLeases").doc(sessionId).get();
  const lease = leaseSnap.exists ? leaseSnap.data() : null;
  if (
    shouldPostponeCleanupForActiveLease({
      leaseStatus: (lease?.status as string) || null,
      leaseExpiresAt: (lease?.leaseExpiresAt as string) || null,
      leaseClosed: Boolean(lease?.closed),
      nowMs,
    })
  ) {
    logger.info("presentation_cleanup_postponed_active_lease", {
      sessionId,
      reason: evaluation.reason,
      dryRun,
    });
    return {
      result: "postponed",
      reason: evaluation.reason,
      effectiveLastActivityAt: evaluation.effectiveLastActivityAt,
    };
  }

  if (dryRun) {
    return {
      result: "would_delete",
      reason: evaluation.reason,
      effectiveLastActivityAt: evaluation.effectiveLastActivityAt,
    };
  }

  await permanentlyDeletePresentationOperational({
    sessionId,
    actorUid: null,
    actorType: "system",
    trigger: "scheduled_cleanup",
    cleanupReason: evaluation.reason,
  });

  logger.info("presentation_cleanup_deleted", {
    sessionId,
    reason: evaluation.reason,
    effectiveLastActivityAt: evaluation.effectiveLastActivityAt,
  });
  return {
    result: "deleted",
    reason: evaluation.reason,
    effectiveLastActivityAt: evaluation.effectiveLastActivityAt,
  };
}

async function collectCandidates(
  nowIso: string,
  inactivityCutoffIso: string,
): Promise<QueryDocumentSnapshot[]> {
  const seen = new Set<string>();
  const candidates: QueryDocumentSnapshot[] = [];

  const pushUnique = (docs: QueryDocumentSnapshot[]) => {
    for (const doc of docs) {
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      candidates.push(doc);
    }
  };

  // Paginate expired
  let lastExp: QueryDocumentSnapshot | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = db
      .collection("presentationSessions")
      .where("expiresAt", "<=", nowIso)
      .orderBy("expiresAt", "asc")
      .limit(BATCH_LIMIT);
    if (lastExp) q = q.startAfter(lastExp);
    const snap = await q.get();
    if (snap.empty) break;
    pushUnique(snap.docs);
    lastExp = snap.docs[snap.docs.length - 1];
    if (snap.size < BATCH_LIMIT) break;
  }

  // Paginate inactivity field
  let lastInact: QueryDocumentSnapshot | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = db
      .collection("presentationSessions")
      .where("lastMeaningfulClientActivityAt", "<=", inactivityCutoffIso)
      .orderBy("lastMeaningfulClientActivityAt", "asc")
      .limit(BATCH_LIMIT);
    if (lastInact) q = q.startAfter(lastInact);
    const snap = await q.get();
    if (snap.empty) break;
    pushUnique(snap.docs);
    lastInact = snap.docs[snap.docs.length - 1];
    if (snap.size < BATCH_LIMIT) break;
  }

  // Legacy sessions without activity field
  let lastLegacy: QueryDocumentSnapshot | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = db
      .collection("presentationSessions")
      .where("createdAt", "<=", inactivityCutoffIso)
      .orderBy("createdAt", "asc")
      .limit(BATCH_LIMIT);
    if (lastLegacy) q = q.startAfter(lastLegacy);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      if (doc.data().lastMeaningfulClientActivityAt) continue;
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      candidates.push(doc);
    }
    lastLegacy = snap.docs[snap.docs.length - 1];
    if (snap.size < BATCH_LIMIT) break;
  }

  return candidates;
}

export type PresentationCleanupRunResult = {
  dryRun: boolean;
  scanned: number;
  /** Eligible and not lease-protected (deleted or would delete). */
  eligibleForRemoval: number;
  deleted: number;
  wouldDelete: number;
  postponed: number;
  skipped: number;
  byReason: {
    invitation_expired: number;
    client_inactivity: number;
  };
  legalEvidencePreserved: true;
  legalAcceptancesPreserved: true;
  auditEventsPreserved: true;
  invitationHistoryPreserved: true;
};

/**
 * Scan candidates and purge operational invite/session rows when:
 * - invitation/link expired, OR
 * - no meaningful client activity for 7 consecutive days
 * Postpones when an active viewing lease exists.
 */
export async function runPresentationOperationalCleanup(input?: {
  nowMs?: number;
  dryRun?: boolean;
}): Promise<PresentationCleanupRunResult> {
  const nowMs = input?.nowMs ?? Date.now();
  const dryRun = input?.dryRun === true;
  const nowIso = new Date(nowMs).toISOString();
  const inactivityCutoffIso = new Date(
    nowMs - PRESENTATION_INACTIVITY_CLEANUP_MS,
  ).toISOString();

  const candidates = await collectCandidates(nowIso, inactivityCutoffIso);

  let deleted = 0;
  let wouldDelete = 0;
  let postponed = 0;
  let skipped = 0;
  const byReason = { invitation_expired: 0, client_inactivity: 0 };

  for (const doc of candidates) {
    try {
      const { result, reason } = await processEligibleSession(
        doc.id,
        doc.data(),
        nowMs,
        dryRun,
      );
      if (result === "deleted") {
        deleted += 1;
        if (reason === "invitation_expired" || reason === "client_inactivity") {
          byReason[reason] += 1;
        }
      } else if (result === "would_delete") {
        wouldDelete += 1;
        if (reason === "invitation_expired" || reason === "client_inactivity") {
          byReason[reason] += 1;
        }
      } else if (result === "postponed") {
        postponed += 1;
      } else {
        skipped += 1;
      }
    } catch (err) {
      skipped += 1;
      logger.error("presentation_cleanup_failed", {
        sessionId: doc.id,
        dryRun,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    dryRun,
    scanned: candidates.length,
    eligibleForRemoval: deleted + wouldDelete,
    deleted,
    wouldDelete,
    postponed,
    skipped,
    byReason,
    legalEvidencePreserved: true,
    legalAcceptancesPreserved: true,
    auditEventsPreserved: true,
    invitationHistoryPreserved: true,
  };
}

/** Daily operational cleanup of expired / inactive invitation portal rows. */
export const purgeInactivePresentations = onSchedule(
  {
    schedule: "every 24 hours",
    timeZone: "America/New_York",
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async () => {
    logger.info("purge_inactive_presentations_start");
    const result = await runPresentationOperationalCleanup({ dryRun: false });
    logger.info("purge_inactive_presentations_complete", result);
  },
);

/** Manual operator trigger (platform admin). Supports dryRun: true. */
export const runPresentationOperationalCleanupNow = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.ADMIN_ACCESS);
  if (!ctx.isPlatformAdmin) {
    throw new HttpsError("permission-denied", "Platform administrator required.");
  }
  const dryRun = request.data?.dryRun === true;
  const result = await runPresentationOperationalCleanup({ dryRun });
  return { ok: true, ...result };
});
