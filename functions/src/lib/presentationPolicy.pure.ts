import {
  ACCESS_POLICY,
  DEFAULT_ACCESS_DURATION_DAYS,
  clampAccessDurationDays,
  normalizeAccessPolicy,
  type AccessPolicy,
} from "../shared";

export function sessionAccessPolicy(
  session: Record<string, unknown>,
): AccessPolicy {
  return normalizeAccessPolicy(session.accessPolicy);
}

export function sessionViewingEntitlementConsumed(
  session: Record<string, unknown>,
): boolean {
  return session.viewingEntitlementConsumed === true;
}

export function sessionIsExpired(session: Record<string, unknown>): boolean {
  const expiresAt = String(session.expiresAt || "");
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() < Date.now();
}

/** Whether client access should be blocked due to consumed single-view entitlement. */
export function sessionSingleViewBlocked(
  session: Record<string, unknown>,
): boolean {
  const policy = sessionAccessPolicy(session);
  if (policy === ACCESS_POLICY.TIME_LIMITED) return false;
  return (
    sessionViewingEntitlementConsumed(session) ||
    session.status === "completed" ||
    session.status === "closed"
  );
}

/**
 * Time-limited (and legacy single-view+expiration) windows use accessDurationDays.
 * Plain single viewing uses the company invite-link TTL (unused-link expiry), not a
 * multi-day replay window.
 *
 * For TIME_LIMITED, createdAtMs is the invite create/send instant — the access clock
 * starts then, not at OTP, legal acceptance, or playback.
 */
export function computeInvitationExpiresAtIso(input: {
  accessPolicy: AccessPolicy | string | null | undefined;
  accessDurationDays?: number | null;
  /** Epoch ms when the invitation is created/sent — starts the access clock. */
  createdAtMs: number;
  companyDefaultInviteTtlHours?: number | null;
}): string {
  const policy = normalizeAccessPolicy(input.accessPolicy);
  const createdAtMs = input.createdAtMs;
  let expiresAtMs: number;
  if (policy === ACCESS_POLICY.SINGLE_VIEW) {
    const ttlHours =
      Number(input.companyDefaultInviteTtlHours) > 0
        ? Number(input.companyDefaultInviteTtlHours)
        : 168;
    expiresAtMs = createdAtMs + ttlHours * 60 * 60 * 1000;
  } else {
    const days = clampAccessDurationDays(
      input.accessDurationDays ?? DEFAULT_ACCESS_DURATION_DAYS,
    );
    expiresAtMs = createdAtMs + days * 24 * 60 * 60 * 1000;
  }
  return new Date(expiresAtMs).toISOString();
}

/**
 * Signed playback URLs must never outlive the snapshotted invitation expiration.
 * Returns null when the invitation is already expired (caller must deny access).
 */
export function capSignedUrlExpiresAtMs(input: {
  nowMs: number;
  signedUrlTtlMs: number;
  invitationExpiresAt?: string | null;
}): number | null {
  const desired = input.nowMs + input.signedUrlTtlMs;
  const raw = String(input.invitationExpiresAt || "").trim();
  if (!raw) return desired;
  const invMs = new Date(raw).getTime();
  if (!Number.isFinite(invMs)) return desired;
  if (invMs <= input.nowMs) return null;
  return Math.min(desired, invMs);
}

/** Single-view completion permanently consumes entitlement; time-limited does not. */
export function shouldConsumeViewingEntitlementOnCompletion(
  policy: AccessPolicy | string | null | undefined,
): boolean {
  return normalizeAccessPolicy(policy) !== ACCESS_POLICY.TIME_LIMITED;
}

/**
 * Fields updated by Reset Authorized Device — must never include expiresAt or
 * viewingEntitlementConsumed (those require a separate explicit owner action).
 */
export const DEVICE_RESET_SAFE_FIELD_PREFIXES = [
  "viewerAuth.authorizedSessionId",
  "viewerAuth.authorizedAt",
  "viewerAuth.emailVerifiedAt",
  "viewerAuth.otpHash",
  "viewerAuth.otpExpiresAt",
  "viewerAuth.otpAttempts",
  "viewerAuth.deviceResetCount",
  "viewerAuth.lastDeviceResetAt",
  "viewerAuth.lastDeviceResetBy",
  "viewingDeviceId",
  "updatedAt",
  "updatedAtServer",
] as const;

export function deviceResetMustNotTouch(): readonly string[] {
  return [
    "expiresAt",
    "expiresAtServer",
    "viewingEntitlementConsumed",
    "accessPolicy",
    "accessDurationDays",
    "policyAppliedAt",
  ];
}

export function genericAccessUnavailableMessage(): string {
  return "This presentation is no longer available. Please contact your representative for assistance.";
}

export const REP_PRESENTATION_CONFIG_ERROR =
  "Your presentation configuration requires administrator attention. Please contact your administrator.";

/**
 * Server-side video selection for NEW invitations.
 * Explicit rep assignment always wins; company default is fallback only when unset.
 */
export function resolveInviteVideoSelection(input: {
  assignedVideoId?: string | null;
  companyActiveVideoId?: string | null;
}): {
  source: "rep_assignment" | "company_fallback" | "none";
  videoId: string | null;
} {
  const assigned = String(input.assignedVideoId || "").trim();
  if (assigned) {
    return { source: "rep_assignment", videoId: assigned };
  }
  const company = String(input.companyActiveVideoId || "").trim();
  if (company) {
    return { source: "company_fallback", videoId: company };
  }
  return { source: "none", videoId: null };
}

/**
 * Historical invite/session videoId never follows later assignment or company changes.
 */
export function snapshottedInviteVideoId(input: {
  inviteVideoId: string;
  laterRepAssignedVideoId?: string | null;
  laterCompanyActiveVideoId?: string | null;
}): string {
  return String(input.inviteVideoId || "").trim();
}

/** createInvite must ignore any client-submitted videoId. */
export function ignoreClientSubmittedVideoId(
  _clientVideoId: string | null | undefined,
): undefined {
  return undefined;
}

/**
 * Presentation assignment and access policy are independent settings.
 * Changing one must not force the other to a different value when merging patches.
 */
export function mergePresentationSettingsPatch(input: {
  previous: {
    activeVideoId?: string | null;
    accessPolicy?: string | null;
    accessDurationDays?: number | null;
  } | null;
  patch: {
    activeVideoId?: string | null;
    accessPolicy?: string | null;
    accessDurationDays?: number | null;
  };
}): {
  activeVideoId: string | null | undefined;
  accessPolicy: string | null | undefined;
  accessDurationDays: number | null | undefined;
} {
  const prev = input.previous || {};
  return {
    activeVideoId:
      input.patch.activeVideoId !== undefined
        ? input.patch.activeVideoId
        : prev.activeVideoId,
    accessPolicy:
      input.patch.accessPolicy !== undefined
        ? input.patch.accessPolicy
        : prev.accessPolicy,
    accessDurationDays:
      input.patch.accessDurationDays !== undefined
        ? input.patch.accessDurationDays
        : prev.accessDurationDays,
  };
}
