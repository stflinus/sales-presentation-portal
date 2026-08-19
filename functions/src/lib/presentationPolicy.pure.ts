import {
  ACCESS_POLICY,
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

export function genericAccessUnavailableMessage(): string {
  return "This presentation is no longer available. Please contact your representative for assistance.";
}

export const REP_PRESENTATION_CONFIG_ERROR =
  "Your presentation configuration requires administrator attention. Please contact your administrator.";
