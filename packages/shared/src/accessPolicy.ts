/** Per-invitation access policy — snapshotted at invitation creation. */

export const ACCESS_POLICY = {
  /** One successful viewing (default / backward compatible). */
  SINGLE_VIEW: "single_view",
  /** Replay allowed until expiresAt. */
  TIME_LIMITED: "time_limited",
  /** One successful viewing OR expires after configured days if unused. */
  SINGLE_VIEW_WITH_EXPIRATION: "single_view_with_expiration",
} as const;

export type AccessPolicy =
  (typeof ACCESS_POLICY)[keyof typeof ACCESS_POLICY];

export const DEFAULT_ACCESS_DURATION_DAYS = 7;

export const MIN_ACCESS_DURATION_DAYS = 1;
export const MAX_ACCESS_DURATION_DAYS = 365;

/** Administrator-configured defaults for a staff user (optional). */
export interface UserPresentationSettings {
  /** Active video from Video Library; null/omitted → company default. */
  activeVideoId?: string | null;
  accessPolicy?: AccessPolicy | null;
  /** Days for time-limited / single-view+expiration policies. */
  accessDurationDays?: number | null;
}

/** Snapshotted onto each invite/session at creation — authoritative after create. */
export interface InvitationAccessPolicySnapshot {
  videoId: string;
  accessPolicy: AccessPolicy;
  accessDurationDays?: number | null;
  expiresAt: string;
  policyAppliedAt: string;
}

export function normalizeAccessPolicy(
  value: unknown,
): AccessPolicy {
  const v = String(value || "").trim();
  if (
    v === ACCESS_POLICY.TIME_LIMITED ||
    v === ACCESS_POLICY.SINGLE_VIEW_WITH_EXPIRATION
  ) {
    return v;
  }
  return ACCESS_POLICY.SINGLE_VIEW;
}

export function isTimeLimitedPolicy(policy: AccessPolicy | string | null | undefined): boolean {
  return normalizeAccessPolicy(policy) === ACCESS_POLICY.TIME_LIMITED;
}

export function isSingleViewEntitlementPolicy(
  policy: AccessPolicy | string | null | undefined,
): boolean {
  const p = normalizeAccessPolicy(policy);
  return (
    p === ACCESS_POLICY.SINGLE_VIEW ||
    p === ACCESS_POLICY.SINGLE_VIEW_WITH_EXPIRATION
  );
}

export function accessPolicyLabel(policy: AccessPolicy | string | null | undefined): string {
  const p = normalizeAccessPolicy(policy);
  if (p === ACCESS_POLICY.TIME_LIMITED) return "Time-Limited Access";
  if (p === ACCESS_POLICY.SINGLE_VIEW_WITH_EXPIRATION) {
    return "Single Viewing + Expiration";
  }
  return "Single Viewing";
}

export function accessPolicySummary(
  policy: AccessPolicy | string | null | undefined,
  accessDurationDays?: number | null,
): string {
  const p = normalizeAccessPolicy(policy);
  const days = accessDurationDays ?? DEFAULT_ACCESS_DURATION_DAYS;
  if (p === ACCESS_POLICY.TIME_LIMITED) return `${days}-Day Access`;
  if (p === ACCESS_POLICY.SINGLE_VIEW_WITH_EXPIRATION) {
    return `Single Viewing · Expires in ${days} days`;
  }
  return "Single Viewing";
}

export function clampAccessDurationDays(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_ACCESS_DURATION_DAYS;
  return Math.min(
    MAX_ACCESS_DURATION_DAYS,
    Math.max(MIN_ACCESS_DURATION_DAYS, Math.floor(n)),
  );
}
