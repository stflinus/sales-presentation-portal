import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  AUDIT_EVENT,
  PERMISSIONS,
  SESSION_STATUS,
  isConsumedStatus,
  type SessionStatus,
} from "../shared";
import { loadStaffContext } from "../lib/authz";
import { writeAuditEvent } from "../lib/audit";
import { db } from "../lib/firebase";
import { clearInterruptedLease } from "../lib/viewingLease";
import { clientIpFromRequest } from "../lib/ua";

/**
 * Clears an interrupted viewing lease so the client can resume.
 * Never reopens a completed/closed (permanently consumed) session.
 * Allowed for: the owning representative (sessions:reset_own), a manager on the
 * same company (sessions:reset_company), or a platform administrator.
 */
export const resetInterruptedSession = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  const sessionId = String(request.data?.sessionId || "");
  const reason = String(request.data?.reason || "interrupted_session").slice(0, 500);
  const ip = clientIpFromRequest(request.rawRequest?.headers["x-forwarded-for"]);

  if (!sessionId) throw new HttpsError("invalid-argument", "sessionId required.");

  const sessionRef = db.collection("presentationSessions").doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) throw new HttpsError("not-found", "Session not found.");
  const session = sessionSnap.data()!;
  const status = session.status as SessionStatus;

  const canResetOwn =
    ctx.permissions.includes(PERMISSIONS.SESSIONS_RESET_OWN) &&
    session.representativeId === ctx.uid;
  const canResetCompany =
    ctx.permissions.includes(PERMISSIONS.SESSIONS_RESET_COMPANY) &&
    Boolean(ctx.companyId) &&
    session.companyId === ctx.companyId;

  if (!ctx.isPlatformAdmin && !canResetOwn && !canResetCompany) {
    throw new HttpsError(
      "permission-denied",
      "Missing permission to reset this session.",
    );
  }

  if (isConsumedStatus(status)) {
    throw new HttpsError(
      "failed-precondition",
      "Completed sessions cannot be reset or reopened. Create a new invitation instead.",
    );
  }

  if (
    status !== SESSION_STATUS.IN_PROGRESS &&
    status !== SESSION_STATUS.LEGAL_ACCEPTED &&
    status !== SESSION_STATUS.OPENED
  ) {
    throw new HttpsError(
      "failed-precondition",
      `Session status '${status}' cannot be reset.`,
    );
  }

  await clearInterruptedLease(sessionId);

  const nowIso = new Date().toISOString();
  await sessionRef.update({
    // Return to legal_accepted if legal was done so client can resume video without re-accepting.
    status:
      session.legalAcceptanceId
        ? SESSION_STATUS.LEGAL_ACCEPTED
        : SESSION_STATUS.OPENED,
    viewingDeviceId: FieldValue.delete(),
    updatedAt: nowIso,
    updatedAtServer: FieldValue.serverTimestamp(),
    lastResetAt: nowIso,
    lastResetBy: ctx.uid,
    lastResetReason: reason,
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.REPRESENTATIVE_ACTION,
    sessionId,
    inviteId: session.inviteId,
    representativeId: session.representativeId,
    actorUid: ctx.uid,
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    ipAddress: ip,
    payload: {
      action: "reset_interrupted_session",
      reason,
      previousStatus: status,
    },
  });

  return {
    ok: true,
    sessionId,
    status: session.legalAcceptanceId
      ? SESSION_STATUS.LEGAL_ACCEPTED
      : SESSION_STATUS.OPENED,
    message:
      "Viewing lease cleared. The client may reopen the invitation and resume. Completion still permanently consumes the viewing.",
  };
});
