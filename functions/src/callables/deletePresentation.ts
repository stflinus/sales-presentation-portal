import { onCall, HttpsError } from "firebase-functions/v2/https";
import { PERMISSIONS } from "../shared";
import {
  assertSessionCompanyAccess,
  loadStaffContext,
} from "../lib/authz";
import { db } from "../lib/firebase";
import { permanentlyDeletePresentationOperational } from "../lib/presentationOperationalDelete";

/**
 * Permanently delete a Presentation (sales record).
 * Not soft-delete / archive. Legal Evidence and audit logs are preserved.
 */
export const deletePresentation = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  if (
    !ctx.isPlatformAdmin &&
    !ctx.permissions.includes(PERMISSIONS.SESSIONS_READ_OWN) &&
    !ctx.permissions.includes(PERMISSIONS.SESSIONS_READ_COMPANY)
  ) {
    throw new HttpsError("permission-denied", "Missing session read permission.");
  }

  const sessionId = String(request.data?.sessionId || "").trim();
  const confirm = String(request.data?.confirm || "").trim();
  if (!sessionId) throw new HttpsError("invalid-argument", "sessionId required.");
  if (confirm !== "DELETE") {
    throw new HttpsError(
      "invalid-argument",
      "Type DELETE to confirm permanent presentation deletion.",
    );
  }

  const sessionSnap = await db.collection("presentationSessions").doc(sessionId).get();
  if (!sessionSnap.exists) {
    throw new HttpsError("not-found", "Presentation not found.");
  }
  await assertSessionCompanyAccess(ctx, sessionSnap.data()!);

  const result = await permanentlyDeletePresentationOperational({
    sessionId,
    actorUid: ctx.uid,
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    trigger: "staff_delete",
  });

  return {
    ok: true,
    deleted: true,
    sessionId: result.sessionId,
    inviteId: result.inviteId,
    legalEvidencePreserved: true,
  };
});
