import { FieldValue } from "firebase-admin/firestore";
import { AUDIT_EVENT } from "../shared";
import { writeAuditEvent } from "./audit";
import { auth, db } from "./firebase";
import {
  invitationSnapshotFromInvite,
  orphanLegalAcceptancesForSession,
  orphanLegalEvidenceForSession,
} from "./legalEvidence";

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

export type PresentationOperationalDeleteResult = {
  sessionId: string;
  inviteId: string | null;
  followUpsDeleted: number;
  notificationsDeleted: number;
  mailDeleted: number;
  analyticsDeleted: number;
  evidenceUnlinked: number;
  acceptanceUnlinked: number;
  invitationMetadataPreserved: boolean;
};

/**
 * Permanently remove operational invite/session portal records.
 * Preserves legalEvidence, legalAcceptances (orphaned), auditEvents,
 * legalDocumentViews, and invitation metadata snapshots on evidence.
 */
export async function permanentlyDeletePresentationOperational(input: {
  sessionId: string;
  actorUid: string | null;
  actorType: "system" | "representative" | "administrator";
  trigger: "staff_delete" | "scheduled_cleanup";
  cleanupReason?: string | null;
}): Promise<PresentationOperationalDeleteResult> {
  const sessionId = input.sessionId;
  const sessionRef = db.collection("presentationSessions").doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) {
    throw new Error(`Presentation session not found: ${sessionId}`);
  }
  const session = sessionSnap.data()!;

  const inviteId = String(session.inviteId || "");
  const companyId = String(session.companyId || "");
  const representativeId = String(session.representativeId || "");
  const contactId = session.contactId ? String(session.contactId) : null;
  const followUpCalendarEventId = session.followUpCalendarEventId
    ? String(session.followUpCalendarEventId)
    : null;

  if (followUpCalendarEventId && representativeId) {
    try {
      const { deleteFollowUpCalendarEvent } = await import(
        "./calendar/CalendarServiceFacade"
      );
      await deleteFollowUpCalendarEvent({
        uid: representativeId,
        eventId: followUpCalendarEventId,
      });
    } catch {
      // non-fatal
    }
  }

  const followUpsDeleted = await deleteQueryDocs(
    "followUps",
    "sessionId",
    sessionId,
  );

  let notificationsDeleted = 0;
  if (inviteId) {
    notificationsDeleted = await deleteQueryDocs(
      "notifications",
      "inviteId",
      inviteId,
    );
  }

  let mailDeleted = 0;
  if (inviteId) {
    mailDeleted = await deleteQueryDocs("mail", "inviteId", inviteId);
  }
  mailDeleted += await deleteQueryDocs("mail", "sessionId", sessionId);

  const analyticsDeleted = await deleteQueryDocs(
    "analyticsEvents",
    "sessionId",
    sessionId,
  );

  try {
    await db.collection("viewingLeases").doc(sessionId).delete();
  } catch {
    /* optional */
  }
  try {
    await db.collection("viewingLocks").doc(sessionId).delete();
  } catch {
    /* optional */
  }

  let invitationSnapshot = null as ReturnType<typeof invitationSnapshotFromInvite>;
  if (inviteId) {
    const inviteSnap = await db.collection("invites").doc(inviteId).get();
    invitationSnapshot = invitationSnapshotFromInvite(
      inviteId,
      inviteSnap.exists ? (inviteSnap.data() as Record<string, unknown>) : null,
    );
  }

  const evidenceUnlinked = await orphanLegalEvidenceForSession(
    sessionId,
    invitationSnapshot,
  );
  const acceptanceUnlinked = await orphanLegalAcceptancesForSession(sessionId);

  if (inviteId) {
    await db.collection("invites").doc(inviteId).delete();
  }

  await sessionRef.delete();

  try {
    await auth.updateUser(`client_${sessionId}`, { disabled: true });
  } catch {
    /* may not exist */
  }

  if (contactId) {
    const contactRef = db.collection("contacts").doc(contactId);
    const contactSnap = await contactRef.get();
    if (contactSnap.exists) {
      const c = contactSnap.data()!;
      const patch: Record<string, unknown> = {
        updatedAt: new Date().toISOString(),
        updatedAtServer: FieldValue.serverTimestamp(),
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
    actorUid: input.actorUid || undefined,
    actorType: input.actorType,
    payload: {
      permanent: true,
      companyId,
      contactId,
      trigger: input.trigger,
      cleanupReason: input.cleanupReason || null,
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
    sessionId,
    inviteId: inviteId || null,
    followUpsDeleted,
    notificationsDeleted,
    mailDeleted,
    analyticsDeleted,
    evidenceUnlinked,
    acceptanceUnlinked,
    invitationMetadataPreserved: Boolean(invitationSnapshot),
  };
}
