/**
 * Pure helpers for staff user edit / delete safety (unit-testable).
 */

import {
  INVITE_STATUS,
  ROLE_IDS,
  SESSION_STATUS,
  isPlatformAdminRole,
  isTerminalStatus,
  type InviteStatus,
  type RoleId,
  type SessionStatus,
} from "../shared";

export function isValidStaffEmail(email: string): boolean {
  const normalized = String(email || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

export function normalizeStaffEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

/** Invite statuses that still represent operational client activity. */
export const ACTIVE_INVITE_STATUSES_FOR_USER_DELETE: readonly InviteStatus[] = [
  INVITE_STATUS.PENDING,
  INVITE_STATUS.SENT,
  INVITE_STATUS.OPENED,
  INVITE_STATUS.ACCEPTED,
] as const;

export function inviteBlocksUserDeletion(
  status: InviteStatus | string | null | undefined,
): boolean {
  if (!status) return false;
  return (ACTIVE_INVITE_STATUSES_FOR_USER_DELETE as readonly string[]).includes(status);
}

export function sessionBlocksUserDeletion(
  status: SessionStatus | string | null | undefined,
): boolean {
  if (!status) return false;
  if (isTerminalStatus(status as SessionStatus)) return false;
  // Treat in-progress / opened / pending / legal as active business activity.
  const active = new Set<string>([
    SESSION_STATUS.PENDING,
    SESSION_STATUS.OPENED,
    SESSION_STATUS.LEGAL_ACCEPTED,
    SESSION_STATUS.IN_PROGRESS,
  ]);
  return active.has(status);
}

export function formatUserDeletionBlockMessage(input: {
  displayName: string;
  activeInviteCount: number;
  activeSessionCount: number;
}): string {
  const name = input.displayName || "This user";
  const parts: string[] = [];
  if (input.activeInviteCount > 0) {
    parts.push(
      `${input.activeInviteCount} active client invitation${
        input.activeInviteCount === 1 ? "" : "s"
      }`,
    );
  }
  if (input.activeSessionCount > 0) {
    parts.push(
      `${input.activeSessionCount} active presentation session${
        input.activeSessionCount === 1 ? "" : "s"
      }`,
    );
  }
  const detail = parts.join(" and ");
  return `${name} currently has ${detail}. Deactivate the user or allow these invitations/sessions to expire before permanently deleting the account.`;
}

export function canActorModifyTargetRole(input: {
  actorIsPlatformAdmin: boolean;
  targetRole: RoleId | string | null | undefined;
}): boolean {
  if (isPlatformAdminRole(input.targetRole)) {
    return input.actorIsPlatformAdmin;
  }
  return true;
}

export function assertNotSelfDestructiveDelete(input: {
  actorUid: string;
  targetUid: string;
}): { ok: true } | { ok: false; reason: string } {
  if (input.actorUid === input.targetUid) {
    return {
      ok: false,
      reason: "You cannot permanently delete your own signed-in account.",
    };
  }
  return { ok: true };
}

/**
 * Prevent demoting/deleting the last remaining active platform owner/admin.
 */
export function wouldRemoveLastPlatformOwner(input: {
  targetUid: string;
  targetRole: RoleId | string | null | undefined;
  targetStatus: string | null | undefined;
  action: "delete" | "deactivate" | "demote";
  activeOwnerAdminUids: string[];
}): { ok: true } | { ok: false; reason: string } {
  if (!isPlatformAdminRole(input.targetRole)) return { ok: true };
  const activeOwners = input.activeOwnerAdminUids.filter(Boolean);
  const isActiveTarget =
    input.targetStatus === "active" || input.targetStatus == null;
  if (!isActiveTarget && input.action !== "delete") return { ok: true };

  const remaining = activeOwners.filter((uid) => uid !== input.targetUid);
  if (remaining.length === 0) {
    return {
      ok: false,
      reason:
        "Cannot remove or demote the last remaining platform owner/administrator.",
    };
  }
  return { ok: true };
}

export function staffRoleAssignableByAdmin(role: RoleId | string): boolean {
  return role === ROLE_IDS.REPRESENTATIVE || role === ROLE_IDS.MANAGER;
}

export function generateUserErrorCode(): string {
  const hex = Math.random().toString(16).slice(2, 8).toUpperCase().padEnd(6, "0");
  return `USR-${hex}`;
}
