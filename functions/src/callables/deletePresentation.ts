import { onCall, HttpsError } from "firebase-functions/v2/https";
import { AUDIT_EVENT, PERMISSIONS } from "../shared";
import {
  assertSessionCompanyAccess,
  loadStaffContext,
} from "../lib/authz";
import { writeAuditEvent } from "../lib/audit";
import { auth, db } from "../lib/firebase";
import {
  invitationSnapshotFromInvite,
  orphanLegalAcceptancesForSession,
  orphanLegalEvidenceForSession,
} from "../lib/legalEvidence";

async function deleteQueryDocs(
  collection: string,
  field: string,
  value: string,
): Promise<number> {
  const snap = await db.collection(collection).where(field, "==", value).get();
  for (const doc of snap.docs) {
    await doc.ref.delete();
  }
  return snap.size;
}

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

  const sessionRef = db.collection("presentationSessions").doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) {
    throw new HttpsError("not-found", "Presentation not found.");
  }
  const session = sessionSnap.data()!;
  await assertSessionCompanyAccess(ctx, session);

  const inviteId = String(session.inviteId || "");
  const companyId = String(session.companyId || "");
  const representativeId = String(session.representativeId || "");
  const contactId = session.contactId ? String(session.contactId) : null;
  const followUpCalendarEventId = session.followUpCalendarEventId
    ? String(session.followUpCalendarEventId)
    : null;

  // 0) Calendar appointment via CalendarService (V0.1 internal = no-op)
  if (followUpCalendarEventId && representativeId) {
    const { deleteFollowUpCalendarEvent } = await import(
      "../lib/calendar/CalendarServiceFacade"
    );
    await deleteFollowUpCalendarEvent({
      uid: representativeId,
      eventId: followUpCalendarEventId,
    });
  }

  // 1) Follow-ups / future reminders (sales workflow)
  const followUpsDeleted = await deleteQueryDocs(
    "followUps",
    "sessionId",
    sessionId,
  );

  // 2) Delivery notifications for this invitation (sales workflow only)
  let notificationsDeleted = 0;
  if (inviteId) {
    notificationsDeleted = await deleteQueryDocs(
      "notifications",
      "inviteId",
      inviteId,
    );
  }

  // 2b) Firebase Trigger Email queue docs for this invite (if any)
  let mailDeleted = 0;
  if (inviteId) {
    mailDeleted = await deleteQueryDocs("mail", "inviteId", inviteId);
  }
  mailDeleted += await deleteQueryDocs("mail", "sessionId", sessionId);

  // 3) Analytics (sales dashboard metrics — not legal evidence)
  const analyticsDeleted = await deleteQueryDocs(
    "analyticsEvents",
    "sessionId",
    sessionId,
  );

  // 4) Viewing lease / locks
  try {
    await db.collection("viewingLeases").doc(sessionId).delete();
  } catch {
    // optional
  }
  try {
    await db.collection("viewingLocks").doc(sessionId).delete();
  } catch {
    // optional
  }

  // 5) Capture invitation metadata for evidence before deleting the sales invite
  let invitationSnapshot = null as ReturnType<typeof invitationSnapshotFromInvite>;
  if (inviteId) {
    const inviteSnap = await db.collection("invites").doc(inviteId).get();
    invitationSnapshot = invitationSnapshotFromInvite(
      inviteId,
      inviteSnap.exists ? (inviteSnap.data() as Record<string, unknown>) : null,
    );
  }

  // 6) Legal Evidence / acceptances: break Presentation relationship only
  const evidenceUnlinked = await orphanLegalEvidenceForSession(
    sessionId,
    invitationSnapshot,
  );
  const acceptanceUnlinked = await orphanLegalAcceptancesForSession(sessionId);

  // 7) Invitation sales record (operational) — evidence keeps invitationSnapshot
  if (inviteId) {
    await db.collection("invites").doc(inviteId).delete();
  }

  // 8) Presentation session (includes representative notes)
  await sessionRef.delete();

  // 9) Disable client auth user if present
  try {
    await auth.updateUser(`client_${sessionId}`, { disabled: true });
  } catch {
    // may not exist
  }

  // 10) Clear contact last-session pointers if they pointed here
  if (contactId) {
    const contactRef = db.collection("contacts").doc(contactId);
    const contactSnap = await contactRef.get();
    if (contactSnap.exists) {
      const c = contactSnap.data()!;
      const patch: Record<string, unknown> = {
        updatedAt: new Date().toISOString(),
      };
      if (c.lastSessionId === sessionId) patch.lastSessionId = null;
      if (inviteId && c.lastInviteId === inviteId) patch.lastInviteId = null;
      await contactRef.update(patch);
    }
  }

  // auditEvents and legalDocumentViews are NEVER deleted.

  await writeAuditEvent({
    type: AUDIT_EVENT.PRESENTATION_DELETED,
    sessionId,
    inviteId: inviteId || undefined,
    representativeId,
    actorUid: ctx.uid,
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    payload: {
      permanent: true,
      companyId,
      contactId,
      followUpsDeleted,
      notificationsDeleted,
      mailDeleted,
      analyticsDeleted,
      evidenceUnlinked,
      acceptanceUnlinked,
      legalEvidencePreserved: true,
      invitationMetadataPreserved: Boolean(invitationSnapshot),
      auditLogsPreserved: true,
    },
  });

  return {
    ok: true,
    deleted: true,
    sessionId,
    inviteId: inviteId || null,
    legalEvidencePreserved: true,
  };
});
