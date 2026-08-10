import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  AUDIT_EVENT,
  CONTACT_STATUS,
  INVITE_STATUS,
  PERMISSIONS,
  SESSION_STATUS,
  type ContactStatus,
} from "../shared";
import {
  assertHasPermission,
  loadStaffContext,
  resolveActingCompanyId,
  type StaffContext,
} from "../lib/authz";
import { writeAuditEvent } from "../lib/audit";
import { db } from "../lib/firebase";

function nowIso() {
  return new Date().toISOString();
}

const ACTIVE_CONTACT_STATUSES = new Set<string>([
  CONTACT_STATUS.LEAD,
  CONTACT_STATUS.INVITED,
  CONTACT_STATUS.PRESENTATION_STARTED,
  CONTACT_STATUS.PRESENTATION_COMPLETED,
  CONTACT_STATUS.QUALIFIED,
  CONTACT_STATUS.CUSTOMER,
]);

function canReadContact(
  ctx: StaffContext,
  contact: { ownerRepresentativeId?: string | null; companyId?: string },
): boolean {
  if (ctx.isPlatformAdmin || ctx.permissions.includes(PERMISSIONS.CONTACTS_MANAGE_ALL)) {
    return true;
  }
  if (
    ctx.permissions.includes(PERMISSIONS.CONTACTS_READ_COMPANY) ||
    ctx.permissions.includes(PERMISSIONS.CONTACTS_MANAGE_COMPANY)
  ) {
    return Boolean(ctx.companyId && contact.companyId === ctx.companyId);
  }
  if (ctx.permissions.includes(PERMISSIONS.CONTACTS_MANAGE_OWN)) {
    return contact.ownerRepresentativeId === ctx.uid;
  }
  return false;
}

function assertCanReadContact(
  ctx: StaffContext,
  contact: { ownerRepresentativeId?: string | null; companyId?: string },
): void {
  if (!canReadContact(ctx, contact)) {
    throw new HttpsError("permission-denied", "Contact access denied.");
  }
}

function assertCanManageContact(
  ctx: StaffContext,
  contact: { ownerRepresentativeId?: string | null; companyId?: string },
  mode: "own" | "company",
): void {
  if (ctx.isPlatformAdmin || ctx.permissions.includes(PERMISSIONS.CONTACTS_MANAGE_ALL)) {
    return;
  }
  if (mode === "company") {
    if (
      !ctx.permissions.includes(PERMISSIONS.CONTACTS_MANAGE_COMPANY) ||
      !ctx.companyId ||
      contact.companyId !== ctx.companyId
    ) {
      throw new HttpsError("permission-denied", "Company contact manage denied.");
    }
    return;
  }
  if (
    !ctx.permissions.includes(PERMISSIONS.CONTACTS_MANAGE_OWN) ||
    contact.ownerRepresentativeId !== ctx.uid
  ) {
    throw new HttpsError("permission-denied", "Own contact manage denied.");
  }
}

/** List contacts visible to the caller. */
export const listContacts = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  const includeArchived = request.data?.includeArchived === true;
  const includeDeleted = request.data?.includeDeleted === true;

  let snap;
  if (ctx.isPlatformAdmin || ctx.permissions.includes(PERMISSIONS.CONTACTS_MANAGE_ALL)) {
    snap = await db.collection("contacts").get();
  } else if (
    ctx.permissions.includes(PERMISSIONS.CONTACTS_READ_COMPANY) ||
    ctx.permissions.includes(PERMISSIONS.CONTACTS_MANAGE_COMPANY)
  ) {
    if (!ctx.companyId) {
      throw new HttpsError("failed-precondition", "No company assignment.");
    }
    snap = await db
      .collection("contacts")
      .where("companyId", "==", ctx.companyId)
      .get();
  } else if (ctx.permissions.includes(PERMISSIONS.CONTACTS_MANAGE_OWN)) {
    snap = await db
      .collection("contacts")
      .where("ownerRepresentativeId", "==", ctx.uid)
      .get();
  } else {
    throw new HttpsError("permission-denied", "Missing contacts permission.");
  }

  const contacts = snap.docs
    .map((d) => {
      const row = d.data() as Record<string, unknown>;
      return { id: d.id, ...row } as Record<string, unknown> & { id: string };
    })
    .filter((c) => {
      const status = String(c.status || "");
      if (status === CONTACT_STATUS.DELETED) return includeDeleted;
      if (status === CONTACT_STATUS.ARCHIVED) return includeArchived;
      return true;
    })
    .sort((a, b) =>
      String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")),
    );

  return { contacts };
});

/** Create a contact (Lead). */
export const createContact = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.CONTACTS_MANAGE_OWN);

  const displayName = String(request.data?.displayName || "").trim();
  const email = String(request.data?.email || "").trim().toLowerCase();
  const phone =
    typeof request.data?.phone === "string"
      ? request.data.phone.trim().slice(0, 40)
      : null;
  const notes =
    typeof request.data?.notes === "string"
      ? request.data.notes.trim().slice(0, 10000)
      : "";

  if (!displayName || displayName.length > 200) {
    throw new HttpsError("invalid-argument", "Valid contact name required.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError("invalid-argument", "Valid contact email required.");
  }

  let companyId: string;
  let ownerRepresentativeId = ctx.uid;
  if (ctx.isPlatformAdmin) {
    companyId = resolveActingCompanyId(
      ctx,
      typeof request.data?.companyId === "string" ? request.data.companyId : null,
    );
    if (typeof request.data?.ownerRepresentativeId === "string") {
      ownerRepresentativeId = request.data.ownerRepresentativeId.trim();
    }
  } else {
    companyId = resolveActingCompanyId(ctx, null);
  }

  const ref = db.collection("contacts").doc();
  const iso = nowIso();
  const contact = {
    id: ref.id,
    displayName,
    email,
    phone,
    companyId,
    ownerRepresentativeId,
    status: CONTACT_STATUS.LEAD as ContactStatus,
    notes,
    createdAt: iso,
    createdBy: ctx.uid,
    updatedAt: iso,
    updatedBy: ctx.uid,
    archivedAt: null,
    archivedBy: null,
    deletedAt: null,
    deletedBy: null,
    lastInvitedAt: null,
    lastSessionId: null,
    lastInviteId: null,
  };

  await ref.set({
    ...contact,
    createdAtServer: FieldValue.serverTimestamp(),
    updatedAtServer: FieldValue.serverTimestamp(),
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.CONTACT_CREATED,
    representativeId: ownerRepresentativeId,
    actorUid: ctx.uid,
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    payload: {
      contactId: ref.id,
      companyId,
      email,
      displayName,
    },
  });

  return { contact };
});

/** Update contact name/email/notes/status (non-archive lifecycle). */
export const updateContact = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  const contactId = String(request.data?.contactId || "").trim();
  if (!contactId) throw new HttpsError("invalid-argument", "contactId required.");

  const ref = db.collection("contacts").doc(contactId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Contact not found.");
  const data = snap.data()!;
  if (data.status === CONTACT_STATUS.DELETED) {
    throw new HttpsError("failed-precondition", "Contact is deleted.");
  }

  if (
    !(
      ctx.isPlatformAdmin ||
      ctx.permissions.includes(PERMISSIONS.CONTACTS_MANAGE_ALL) ||
      (ctx.permissions.includes(PERMISSIONS.CONTACTS_MANAGE_OWN) &&
        data.ownerRepresentativeId === ctx.uid)
    )
  ) {
    assertCanManageContact(ctx, data, "company");
  }

  const patch: Record<string, unknown> = {
    updatedAt: nowIso(),
    updatedBy: ctx.uid,
    updatedAtServer: FieldValue.serverTimestamp(),
  };

  if (typeof request.data?.displayName === "string") {
    const displayName = request.data.displayName.trim();
    if (!displayName || displayName.length > 200) {
      throw new HttpsError("invalid-argument", "Valid contact name required.");
    }
    patch.displayName = displayName;
  }
  if (typeof request.data?.email === "string") {
    const email = request.data.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpsError("invalid-argument", "Valid contact email required.");
    }
    patch.email = email;
  }
  if (typeof request.data?.phone === "string") {
    patch.phone = request.data.phone.trim().slice(0, 40) || null;
  }
  if (typeof request.data?.notes === "string") {
    patch.notes = request.data.notes.slice(0, 10000);
  }
  if (typeof request.data?.status === "string") {
    const status = request.data.status as ContactStatus;
    if (
      !ACTIVE_CONTACT_STATUSES.has(status) &&
      status !== CONTACT_STATUS.QUALIFIED &&
      status !== CONTACT_STATUS.CUSTOMER
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Use archive/restore/delete for those statuses.",
      );
    }
    if (ACTIVE_CONTACT_STATUSES.has(status)) {
      patch.status = status;
    }
  }

  await ref.update(patch);
  await writeAuditEvent({
    type: AUDIT_EVENT.CONTACT_UPDATED,
    representativeId: data.ownerRepresentativeId || undefined,
    actorUid: ctx.uid,
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    payload: { contactId, fields: Object.keys(patch) },
  });

  const after = await ref.get();
  return { contact: { id: after.id, ...after.data() } };
});

export const archiveContact = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  const contactId = String(request.data?.contactId || "").trim();
  if (!contactId) throw new HttpsError("invalid-argument", "contactId required.");
  const ref = db.collection("contacts").doc(contactId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Contact not found.");
  const data = snap.data()!;
  if (data.status === CONTACT_STATUS.DELETED) {
    throw new HttpsError("failed-precondition", "Contact is deleted.");
  }

  if (data.ownerRepresentativeId === ctx.uid) {
    assertCanManageContact(ctx, data, "own");
  } else {
    assertCanManageContact(ctx, data, "company");
  }

  const iso = nowIso();
  await ref.update({
    status: CONTACT_STATUS.ARCHIVED,
    archivedAt: iso,
    archivedBy: ctx.uid,
    updatedAt: iso,
    updatedBy: ctx.uid,
    updatedAtServer: FieldValue.serverTimestamp(),
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.CONTACT_ARCHIVED,
    representativeId: data.ownerRepresentativeId || undefined,
    actorUid: ctx.uid,
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    payload: { contactId, companyId: data.companyId },
  });

  return { ok: true, contactId, status: CONTACT_STATUS.ARCHIVED };
});

export const restoreContact = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  const contactId = String(request.data?.contactId || "").trim();
  if (!contactId) throw new HttpsError("invalid-argument", "contactId required.");
  const ref = db.collection("contacts").doc(contactId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Contact not found.");
  const data = snap.data()!;
  if (data.status !== CONTACT_STATUS.ARCHIVED) {
    throw new HttpsError("failed-precondition", "Contact is not archived.");
  }

  assertCanManageContact(ctx, data, "company");

  const iso = nowIso();
  await ref.update({
    status: CONTACT_STATUS.LEAD,
    archivedAt: null,
    archivedBy: null,
    updatedAt: iso,
    updatedBy: ctx.uid,
    updatedAtServer: FieldValue.serverTimestamp(),
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.CONTACT_RESTORED,
    representativeId: data.ownerRepresentativeId || undefined,
    actorUid: ctx.uid,
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    payload: { contactId, companyId: data.companyId },
  });

  return { ok: true, contactId, status: CONTACT_STATUS.LEAD };
});

/**
 * Destructive delete: removes contact operational data.
 * Preserves legal acceptances (orphaned) and audit logs.
 */
export const deleteContact = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  const contactId = String(request.data?.contactId || "").trim();
  const confirm = request.data?.confirm === true;
  if (!contactId) throw new HttpsError("invalid-argument", "contactId required.");
  if (!confirm) {
    throw new HttpsError("invalid-argument", "confirm=true required to delete.");
  }

  const ref = db.collection("contacts").doc(contactId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Contact not found.");
  const data = snap.data()!;

  if (data.ownerRepresentativeId === ctx.uid) {
    assertCanManageContact(ctx, data, "own");
  } else {
    assertCanManageContact(ctx, data, "company");
  }

  const iso = nowIso();

  // Orphan legal evidence & acceptances — only contactId may change.
  const { orphanLegalAcceptancesForContact, orphanLegalEvidenceForContact } =
    await import("../lib/legalEvidence");
  const evidenceOrphaned = await orphanLegalEvidenceForContact(contactId);
  const acceptanceOrphaned = await orphanLegalAcceptancesForContact(contactId);

  // Remove follow-ups for this contact
  const followUps = await db
    .collection("followUps")
    .where("contactId", "==", contactId)
    .get();
  for (const doc of followUps.docs) {
    await doc.ref.delete();
  }

  // Revoke future/pending invites; keep invitation identifiers on legal records
  const invites = await db
    .collection("invites")
    .where("contactId", "==", contactId)
    .get();
  for (const doc of invites.docs) {
    const inv = doc.data();
    const status = String(inv.status || "");
    if (
      status === INVITE_STATUS.PENDING ||
      status === INVITE_STATUS.SENT
    ) {
      await doc.ref.update({
        status: INVITE_STATUS.REVOKED,
        contactId: FieldValue.delete(),
        updatedAt: iso,
      });
      if (inv.sessionId) {
        await db.collection("presentationSessions").doc(inv.sessionId).update({
          status: SESSION_STATUS.REVOKED,
          contactId: FieldValue.delete(),
          closedAt: iso,
          updatedAt: iso,
          updatedAtServer: FieldValue.serverTimestamp(),
        });
      }
    } else {
      await doc.ref.update({
        contactId: FieldValue.delete(),
        updatedAt: iso,
      });
    }
  }

  // Unlink / close open sessions for this contact
  const sessions = await db
    .collection("presentationSessions")
    .where("contactId", "==", contactId)
    .get();
  for (const doc of sessions.docs) {
    const s = doc.data();
    const status = String(s.status || "");
    const patch: Record<string, unknown> = {
      contactId: FieldValue.delete(),
      updatedAt: iso,
      updatedAtServer: FieldValue.serverTimestamp(),
    };
    if (
      status === SESSION_STATUS.PENDING ||
      status === SESSION_STATUS.OPENED ||
      status === SESSION_STATUS.LEGAL_ACCEPTED ||
      status === SESSION_STATUS.IN_PROGRESS
    ) {
      patch.status = SESSION_STATUS.REVOKED;
      patch.closedAt = iso;
    }
    await doc.ref.update(patch);
  }

  // Remove contact record
  await ref.delete();

  await writeAuditEvent({
    type: AUDIT_EVENT.CONTACT_DELETED,
    representativeId: data.ownerRepresentativeId || undefined,
    actorUid: ctx.uid,
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    payload: {
      contactId,
      companyId: data.companyId,
      email: data.email,
      displayName: data.displayName,
      legalOrphaned: evidenceOrphaned + acceptanceOrphaned,
      evidenceOrphaned,
      acceptanceOrphaned,
    },
  });

  return { ok: true, contactId, deleted: true };
});

/** Transfer contact ownership to another Representative in the same company. */
export const reassignContact = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  const contactId = String(request.data?.contactId || "").trim();
  const newOwnerId = String(request.data?.newOwnerRepresentativeId || "").trim();
  if (!contactId || !newOwnerId) {
    throw new HttpsError(
      "invalid-argument",
      "contactId and newOwnerRepresentativeId required.",
    );
  }

  const ref = db.collection("contacts").doc(contactId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Contact not found.");
  const data = snap.data()!;
  if (data.status === CONTACT_STATUS.DELETED) {
    throw new HttpsError("failed-precondition", "Contact is deleted.");
  }

  assertCanManageContact(ctx, data, "company");

  const ownerSnap = await db.collection("users").doc(newOwnerId).get();
  if (!ownerSnap.exists) {
    throw new HttpsError("not-found", "Target representative not found.");
  }
  const owner = ownerSnap.data()!;
  if (owner.companyId !== data.companyId) {
    throw new HttpsError(
      "permission-denied",
      "Target representative must be in the same company.",
    );
  }
  if (owner.status === "inactive" || owner.status === "disabled") {
    throw new HttpsError("failed-precondition", "Target representative inactive.");
  }

  const previousOwnerId = data.ownerRepresentativeId || null;
  const iso = nowIso();
  const ownerName = String(owner.displayName || owner.email || "Representative");

  await ref.update({
    ownerRepresentativeId: newOwnerId,
    updatedAt: iso,
    updatedBy: ctx.uid,
    updatedAtServer: FieldValue.serverTimestamp(),
  });

  // Transfer notes/invites/follow-ups/open sessions
  const invites = await db
    .collection("invites")
    .where("contactId", "==", contactId)
    .get();
  for (const doc of invites.docs) {
    await doc.ref.update({
      createdBy: newOwnerId,
      representativeName: ownerName,
      updatedAt: iso,
    });
  }

  const sessions = await db
    .collection("presentationSessions")
    .where("contactId", "==", contactId)
    .get();
  for (const doc of sessions.docs) {
    await doc.ref.update({
      representativeId: newOwnerId,
      representativeName: ownerName,
      updatedAt: iso,
      updatedAtServer: FieldValue.serverTimestamp(),
    });
  }

  const followUps = await db
    .collection("followUps")
    .where("contactId", "==", contactId)
    .get();
  for (const doc of followUps.docs) {
    await doc.ref.update({
      representativeId: newOwnerId,
      updatedAt: iso,
      updatedAtServer: FieldValue.serverTimestamp(),
    });
  }

  await writeAuditEvent({
    type: AUDIT_EVENT.CONTACT_REASSIGNED,
    representativeId: newOwnerId,
    actorUid: ctx.uid,
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    payload: {
      contactId,
      companyId: data.companyId,
      previousOwnerId,
      newOwnerId,
    },
  });

  return { ok: true, contactId, ownerRepresentativeId: newOwnerId };
});

export const getContact = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  const contactId = String(request.data?.contactId || "").trim();
  if (!contactId) throw new HttpsError("invalid-argument", "contactId required.");
  const snap = await db.collection("contacts").doc(contactId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Contact not found.");
  const data = snap.data()!;
  assertCanReadContact(ctx, data);
  return { contact: { id: snap.id, ...data } };
});
