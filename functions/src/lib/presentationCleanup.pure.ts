/**
 * Pure helpers for operational presentation/invite cleanup eligibility.
 * Does NOT change Single Viewing / Time-Limited access authorization.
 */

import {
  PRESENTATION_INACTIVITY_CLEANUP_MS,
  SESSION_STATUS,
  type SessionStatus,
} from "../shared";

export type PresentationCleanupReason =
  | "invitation_expired"
  | "client_inactivity"
  | null;

export function parseIsoMs(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const ms = new Date(String(value)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Resolve the inactivity clock baseline.
 * Prefer explicit lastMeaningfulClientActivityAt; otherwise reconstruct from
 * historical client timestamps; if never opened, use sent/created.
 */
export function resolveLastMeaningfulClientActivityAt(input: {
  lastMeaningfulClientActivityAt?: string | null;
  createdAt?: string | null;
  sentAt?: string | null;
  openedAt?: string | null;
  authorizedAt?: string | null;
  invitationOpenedAt?: string | null;
  legalAcceptedAt?: string | null;
  videoStartedAt?: string | null;
  completedAt?: string | null;
}): string {
  const explicit = parseIsoMs(input.lastMeaningfulClientActivityAt);
  if (explicit != null) {
    return new Date(explicit).toISOString();
  }

  const clientEvents = [
    parseIsoMs(input.authorizedAt),
    parseIsoMs(input.invitationOpenedAt),
    parseIsoMs(input.openedAt),
    parseIsoMs(input.legalAcceptedAt),
    parseIsoMs(input.videoStartedAt),
    parseIsoMs(input.completedAt),
  ].filter((n): n is number => n != null);

  if (clientEvents.length > 0) {
    return new Date(Math.max(...clientEvents)).toISOString();
  }

  const baseline =
    parseIsoMs(input.sentAt) ?? parseIsoMs(input.createdAt) ?? Date.now();
  return new Date(baseline).toISOString();
}

export function invitationIsExpiredForCleanup(input: {
  expiresAt?: string | null;
  status?: SessionStatus | string | null;
  nowMs?: number;
}): boolean {
  const now = input.nowMs ?? Date.now();
  if (input.status === SESSION_STATUS.EXPIRED) return true;
  const exp = parseIsoMs(input.expiresAt);
  if (exp == null) return false;
  return exp < now;
}

export function isInactivePastCleanupWindow(input: {
  lastMeaningfulClientActivityAt: string;
  nowMs?: number;
  inactivityMs?: number;
}): boolean {
  const now = input.nowMs ?? Date.now();
  const windowMs = input.inactivityMs ?? PRESENTATION_INACTIVITY_CLEANUP_MS;
  const last = parseIsoMs(input.lastMeaningfulClientActivityAt);
  if (last == null) return false;
  return last <= now - windowMs;
}

/**
 * Operational cleanup eligibility (ignores active-lease postponement).
 */
export function evaluatePresentationCleanupEligibility(input: {
  expiresAt?: string | null;
  status?: SessionStatus | string | null;
  lastMeaningfulClientActivityAt?: string | null;
  createdAt?: string | null;
  sentAt?: string | null;
  openedAt?: string | null;
  authorizedAt?: string | null;
  invitationOpenedAt?: string | null;
  legalAcceptedAt?: string | null;
  videoStartedAt?: string | null;
  completedAt?: string | null;
  nowMs?: number;
  inactivityMs?: number;
}): {
  eligible: boolean;
  reason: PresentationCleanupReason;
  effectiveLastActivityAt: string;
  invitationExpired: boolean;
  inactivePastWindow: boolean;
} {
  const nowMs = input.nowMs ?? Date.now();
  const effectiveLastActivityAt = resolveLastMeaningfulClientActivityAt(input);
  const invitationExpired = invitationIsExpiredForCleanup({
    expiresAt: input.expiresAt,
    status: input.status,
    nowMs,
  });
  const inactivePastWindow = isInactivePastCleanupWindow({
    lastMeaningfulClientActivityAt: effectiveLastActivityAt,
    nowMs,
    inactivityMs: input.inactivityMs,
  });

  if (invitationExpired) {
    return {
      eligible: true,
      reason: "invitation_expired",
      effectiveLastActivityAt,
      invitationExpired,
      inactivePastWindow,
    };
  }
  if (inactivePastWindow) {
    return {
      eligible: true,
      reason: "client_inactivity",
      effectiveLastActivityAt,
      invitationExpired,
      inactivePastWindow,
    };
  }
  return {
    eligible: false,
    reason: null,
    effectiveLastActivityAt,
    invitationExpired,
    inactivePastWindow,
  };
}

/** Active lease must postpone cleanup (do not interrupt playback). */
export function shouldPostponeCleanupForActiveLease(input: {
  leaseStatus?: string | null;
  leaseExpiresAt?: string | null;
  leaseClosed?: boolean | null;
  nowMs?: number;
}): boolean {
  const now = input.nowMs ?? Date.now();
  if (input.leaseClosed) return false;
  if (String(input.leaseStatus || "") !== "active") return false;
  const exp = parseIsoMs(input.leaseExpiresAt);
  if (exp == null) return false;
  return exp > now;
}
