import { describe, expect, it } from "vitest";

/** Mirrors functions/src/lib/legalEvidence.invitationSnapshotFromInvite */
function invitationSnapshotFromInvite(
  inviteId: string,
  invite: Record<string, unknown> | undefined | null,
) {
  if (!invite) return null;
  return {
    invitationId: inviteId,
    clientName: String(invite.clientName || ""),
    clientEmail: String(invite.clientEmail || ""),
    representativeName: String(invite.representativeName || ""),
    companyId: String(invite.companyId || ""),
    videoId: String(invite.videoId || ""),
    createdAt: invite.createdAt ? String(invite.createdAt) : null,
    sentAt: invite.sentAt ? String(invite.sentAt) : null,
    openedAt: invite.openedAt ? String(invite.openedAt) : null,
    expiresAt: invite.expiresAt ? String(invite.expiresAt) : null,
  };
}

describe("presentation deletion evidence preservations", () => {
  it("builds invitation snapshot without token material", () => {
    const snap = invitationSnapshotFromInvite("inv1", {
      clientName: "Pat",
      clientEmail: "pat@example.com",
      representativeName: "Rep",
      companyId: "serenity-1",
      videoId: "vid1",
      createdAt: "2026-01-01T00:00:00.000Z",
      sentAt: "2026-01-01T01:00:00.000Z",
      tokenHash: "secret-must-not-appear",
    });
    expect(snap).toEqual({
      invitationId: "inv1",
      clientName: "Pat",
      clientEmail: "pat@example.com",
      representativeName: "Rep",
      companyId: "serenity-1",
      videoId: "vid1",
      createdAt: "2026-01-01T00:00:00.000Z",
      sentAt: "2026-01-01T01:00:00.000Z",
      openedAt: null,
      expiresAt: null,
    });
    expect(JSON.stringify(snap)).not.toContain("tokenHash");
    expect(JSON.stringify(snap)).not.toContain("secret");
  });

  it("returns null when invite missing", () => {
    expect(invitationSnapshotFromInvite("inv1", null)).toBeNull();
  });
});
