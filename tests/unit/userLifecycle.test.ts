import { describe, expect, it } from "vitest";
import {
  assertNotSelfDestructiveDelete,
  formatUserDeletionBlockMessage,
  generateUserErrorCode,
  inviteBlocksUserDeletion,
  isValidStaffEmail,
  normalizeStaffEmail,
  sessionBlocksUserDeletion,
  staffRoleAssignableByAdmin,
  wouldRemoveLastPlatformOwner,
} from "../../functions/src/lib/userLifecycle.pure";
import { INVITE_STATUS, ROLE_IDS, SESSION_STATUS } from "../../packages/shared/src";

describe("email validation", () => {
  it("accepts valid emails and normalizes", () => {
    expect(isValidStaffEmail("Dan@Example.com")).toBe(true);
    expect(normalizeStaffEmail("  Dan@Example.com ")).toBe("dan@example.com");
  });

  it("rejects invalid emails", () => {
    expect(isValidStaffEmail("not-an-email")).toBe(false);
    expect(isValidStaffEmail("")).toBe(false);
  });
});

describe("deletion dependency guards", () => {
  it("blocks active invites", () => {
    expect(inviteBlocksUserDeletion(INVITE_STATUS.SENT)).toBe(true);
    expect(inviteBlocksUserDeletion(INVITE_STATUS.ACCEPTED)).toBe(true);
    expect(inviteBlocksUserDeletion(INVITE_STATUS.COMPLETED)).toBe(false);
    expect(inviteBlocksUserDeletion(INVITE_STATUS.REVOKED)).toBe(false);
  });

  it("blocks active sessions but not terminal ones", () => {
    expect(sessionBlocksUserDeletion(SESSION_STATUS.IN_PROGRESS)).toBe(true);
    expect(sessionBlocksUserDeletion(SESSION_STATUS.LEGAL_ACCEPTED)).toBe(true);
    expect(sessionBlocksUserDeletion(SESSION_STATUS.COMPLETED)).toBe(false);
    expect(sessionBlocksUserDeletion(SESSION_STATUS.EXPIRED)).toBe(false);
  });

  it("formats a clear block message", () => {
    const msg = formatUserDeletionBlockMessage({
      displayName: "Dan",
      activeInviteCount: 4,
      activeSessionCount: 0,
    });
    expect(msg).toContain("Dan currently has 4 active client invitations");
    expect(msg).toContain("Deactivate the user");
  });
});

describe("self and last-owner protection", () => {
  it("prevents deleting yourself", () => {
    const r = assertNotSelfDestructiveDelete({
      actorUid: "u1",
      targetUid: "u1",
    });
    expect(r.ok).toBe(false);
  });

  it("allows deleting another user", () => {
    const r = assertNotSelfDestructiveDelete({
      actorUid: "u1",
      targetUid: "u2",
    });
    expect(r.ok).toBe(true);
  });

  it("blocks removing the last platform owner", () => {
    const r = wouldRemoveLastPlatformOwner({
      targetUid: "owner1",
      targetRole: ROLE_IDS.OWNER,
      targetStatus: "active",
      action: "delete",
      activeOwnerAdminUids: ["owner1"],
    });
    expect(r.ok).toBe(false);
  });

  it("allows removing an owner when another remains", () => {
    const r = wouldRemoveLastPlatformOwner({
      targetUid: "owner1",
      targetRole: ROLE_IDS.ADMINISTRATOR,
      targetStatus: "active",
      action: "demote",
      activeOwnerAdminUids: ["owner1", "owner2"],
    });
    expect(r.ok).toBe(true);
  });
});

describe("role helpers", () => {
  it("limits assignable staff roles", () => {
    expect(staffRoleAssignableByAdmin(ROLE_IDS.REPRESENTATIVE)).toBe(true);
    expect(staffRoleAssignableByAdmin(ROLE_IDS.MANAGER)).toBe(true);
    expect(staffRoleAssignableByAdmin(ROLE_IDS.OWNER)).toBe(false);
  });
});

describe("diagnostics", () => {
  it("generates USR-XXXXXX codes", () => {
    const code = generateUserErrorCode();
    expect(code).toMatch(/^USR-[0-9A-F]{6}$/);
  });
});
