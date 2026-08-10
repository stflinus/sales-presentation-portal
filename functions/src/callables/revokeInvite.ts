import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  ACTIVITY_EVENT,
  ACTIVITY_SEVERITY,
  AUDIT_EVENT,
  INVITE_STATUS,
  PERMISSIONS,
  SESSION_STATUS,
} from "../shared";
import { assertHasPermission, loadStaffContext } from "../lib/authz";
import { writeAuditEvent } from "../lib/audit";
import { writePresentationActivity } from "../lib/presentationActivity";
import { auth, db } from "../lib/firebase";

export const revokeInvite = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.INVITES_REVOKE_OWN);
  const inviteId = String(request.data?.inviteId || "");
  if (!inviteId) throw new HttpsError("invalid-argument", "inviteId required.");

  const inviteRef = db.collection("invites").doc(inviteId);
  const inviteSnap = await inviteRef.get();
  if (!inviteSnap.exists) throw new HttpsError("not-found", "Invite not found.");
  const invite = inviteSnap.data()!;

  if (!ctx.isPlatformAdmin) {
    if (invite.createdBy !== ctx.uid) {
      throw new HttpsError("permission-denied", "Not your invitation.");
    }
    if (ctx.companyId && invite.companyId && invite.companyId !== ctx.companyId) {
      throw new HttpsError("permission-denied", "Cross-company access denied.");
    }
  }

  const nowIso = new Date().toISOString();
  await inviteRef.update({ status: INVITE_STATUS.REVOKED });
  await db.collection("presentationSessions").doc(invite.sessionId).update({
    status: SESSION_STATUS.REVOKED,
    closedAt: nowIso,
    updatedAt: nowIso,
    updatedAtServer: FieldValue.serverTimestamp(),
  });

  try {
    await auth.updateUser(`client_${invite.sessionId}`, { disabled: true });
  } catch {
    // may not exist yet
  }

  await writeAuditEvent({
    type: AUDIT_EVENT.REPRESENTATIVE_ACTION,
    sessionId: invite.sessionId,
    inviteId,
    representativeId: invite.createdBy,
    actorUid: ctx.uid,
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    payload: { action: "revoke_invite" },
  });
  await writePresentationActivity({
    sessionId: invite.sessionId,
    inviteId,
    companyId: (invite.companyId as string) || null,
    representativeId: invite.createdBy,
    type: ACTIVITY_EVENT.INVITATION_REVOKED,
    severity: ACTIVITY_SEVERITY.WARNING,
    description: "Invitation was revoked by staff.",
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    actorUid: ctx.uid,
  });

  return { ok: true };
});
