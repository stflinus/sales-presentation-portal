import { FieldValue } from "firebase-admin/firestore";
import type { LegalDocument } from "../shared";
import { db } from "./firebase";

export interface LegalInvitationSnapshot {
  invitationId: string;
  clientName: string;
  clientEmail: string;
  representativeName: string;
  companyId: string;
  videoId: string;
  createdAt: string | null;
  sentAt: string | null;
  openedAt: string | null;
  expiresAt: string | null;
}

export function invitationSnapshotFromInvite(
  inviteId: string,
  invite: Record<string, unknown> | undefined | null,
): LegalInvitationSnapshot | null {
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

export interface CreateLegalEvidenceInput {
  companyId: string;
  representativeId: string;
  representativeName: string;
  invitationId: string;
  sessionId: string;
  contactId: string | null;
  contactName: string;
  contactEmail: string;
  invitationSnapshot?: LegalInvitationSnapshot | null;
  nda: LegalDocument;
  terms: LegalDocument;
  privacy: LegalDocument;
  acceptanceTimestamp: string;
  legalAcceptanceIds: string[];
  acceptanceBatchId: string;
  auditSignature: string;
  auditEventIds: string[];
  ipAddress: string;
  browser: string;
  operatingSystem: string;
  deviceType: string;
  userAgent: string;
  screenResolution: string;
  videoVersionId: string;
  applicationVersion: string;
  ndaSha256: string;
  termsSha256: string;
  privacySha256: string;
}

/**
 * Append-only write to Legal Evidence Vault.
 * Call once at acceptance. Never update except orphaning contactId / sessionId
 * (and filling invitationSnapshot when Presentation is deleted).
 */
export async function createLegalEvidenceRecord(
  input: CreateLegalEvidenceInput,
): Promise<string> {
  const ref = db.collection("legalEvidence").doc();
  const capturedAt = input.acceptanceTimestamp;
  await ref.set({
    id: ref.id,
    companyId: input.companyId,
    representativeId: input.representativeId,
    representativeName: input.representativeName,
    invitationId: input.invitationId,
    sessionId: input.sessionId,
    contactId: input.contactId,
    invitationSnapshot: input.invitationSnapshot || null,
    contactSnapshot: {
      contactId: input.contactId,
      displayName: input.contactName,
      email: input.contactEmail,
      capturedAt,
    },
    contactName: input.contactName,
    contactEmail: input.contactEmail,
    acceptedNda: true,
    acceptedTerms: true,
    acceptedPrivacy: true,
    ndaDocumentId: input.nda.id,
    termsDocumentId: input.terms.id,
    privacyDocumentId: input.privacy.id,
    ndaVersion: input.nda.versionLabel,
    termsVersion: input.terms.versionLabel,
    privacyVersion: input.privacy.versionLabel,
    ndaEffectiveDate: input.nda.effectiveDate || null,
    termsEffectiveDate: input.terms.effectiveDate || null,
    privacyEffectiveDate: input.privacy.effectiveDate || null,
    acceptanceTimestamp: input.acceptanceTimestamp,
    ndaContentSha256: input.ndaSha256,
    termsContentSha256: input.termsSha256,
    privacyContentSha256: input.privacySha256,
    legalAcceptanceIds: input.legalAcceptanceIds,
    acceptanceBatchId: input.acceptanceBatchId,
    auditSignature: input.auditSignature,
    auditEventIds: input.auditEventIds,
    ipAddress: input.ipAddress,
    browser: input.browser,
    operatingSystem: input.operatingSystem,
    deviceType: input.deviceType,
    userAgent: input.userAgent,
    screenResolution: input.screenResolution,
    videoVersionId: input.videoVersionId,
    applicationVersion: input.applicationVersion,
    immutable: true,
    createdAt: capturedAt,
    createdAtServer: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

/** Orphan evidence when Contact is deleted — only contactId may change. */
export async function orphanLegalEvidenceForContact(
  contactId: string,
): Promise<number> {
  const snap = await db
    .collection("legalEvidence")
    .where("contactId", "==", contactId)
    .get();
  for (const doc of snap.docs) {
    await doc.ref.update({ contactId: null });
  }
  return snap.size;
}

export async function orphanLegalAcceptancesForContact(
  contactId: string,
): Promise<number> {
  const snap = await db
    .collection("legalAcceptances")
    .where("contactId", "==", contactId)
    .get();
  for (const doc of snap.docs) {
    await doc.ref.update({ contactId: null });
  }
  return snap.size;
}

/**
 * Orphan evidence when Presentation is permanently deleted —
 * sessionId → null; invitationSnapshot filled if missing so invite may be deleted.
 */
export async function orphanLegalEvidenceForSession(
  sessionId: string,
  invitationSnapshot?: LegalInvitationSnapshot | null,
): Promise<number> {
  const snap = await db
    .collection("legalEvidence")
    .where("sessionId", "==", sessionId)
    .get();
  for (const doc of snap.docs) {
    const patch: Record<string, unknown> = { sessionId: null };
    if (invitationSnapshot && !doc.data().invitationSnapshot) {
      patch.invitationSnapshot = invitationSnapshot;
    }
    await doc.ref.update(patch);
  }
  return snap.size;
}

/** Orphan acceptances when Presentation is deleted — presentationSessionId → null. */
export async function orphanLegalAcceptancesForSession(
  sessionId: string,
): Promise<number> {
  const snap = await db
    .collection("legalAcceptances")
    .where("presentationSessionId", "==", sessionId)
    .get();
  for (const doc of snap.docs) {
    await doc.ref.update({ presentationSessionId: null });
  }
  return snap.size;
}
