import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { AUDIT_EVENT, PERMISSIONS } from "../shared";
import { assertHasPermission, loadStaffContext } from "../lib/authz";
import { writeAuditEvent } from "../lib/audit";
import { db } from "../lib/firebase";

export const updateSessionNotes = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.SESSIONS_NOTE_OWN);
  const sessionId = String(request.data?.sessionId || "");
  const notes = String(request.data?.notes ?? "").slice(0, 10000);
  if (!sessionId) throw new HttpsError("invalid-argument", "sessionId required.");

  const sessionRef = db.collection("presentationSessions").doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) throw new HttpsError("not-found", "Session not found.");
  const session = sessionSnap.data()!;
  if (session.representativeId !== ctx.uid && !ctx.isPlatformAdmin) {
    throw new HttpsError("permission-denied", "Not your session.");
  }

  const nowIso = new Date().toISOString();
  await sessionRef.update({
    representativeNotes: notes,
    updatedAt: nowIso,
    updatedAtServer: FieldValue.serverTimestamp(),
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.REPRESENTATIVE_ACTION,
    sessionId,
    inviteId: session.inviteId,
    representativeId: session.representativeId,
    actorUid: ctx.uid,
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    payload: { action: "update_notes" },
  });

  return { ok: true };
});
