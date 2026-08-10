import { onCall, HttpsError } from "firebase-functions/v2/https";
import { AUDIT_EVENT, PERMISSIONS } from "../shared";
import {
  assertHasPermission,
  loadStaffContext,
} from "../lib/authz";
import { writeAuditEvent } from "../lib/audit";
import { db } from "../lib/firebase";
import { buildSimplePdf } from "../lib/simplePdf";

function canReadEvidence(
  ctx: Awaited<ReturnType<typeof loadStaffContext>>,
  companyId: string,
): boolean {
  if (
    ctx.isPlatformAdmin ||
    ctx.permissions.includes(PERMISSIONS.LEGAL_EVIDENCE_READ_ALL)
  ) {
    return true;
  }
  if (
    ctx.permissions.includes(PERMISSIONS.LEGAL_EVIDENCE_READ_COMPANY) &&
    ctx.companyId &&
    ctx.companyId === companyId
  ) {
    return true;
  }
  return false;
}

function assertCanExport(ctx: Awaited<ReturnType<typeof loadStaffContext>>) {
  if (
    ctx.isPlatformAdmin ||
    ctx.permissions.includes(PERMISSIONS.LEGAL_EVIDENCE_EXPORT)
  ) {
    return;
  }
  throw new HttpsError(
    "permission-denied",
    "Export audit package requires legal_evidence:export.",
  );
}

function redactForManager(row: Record<string, unknown>) {
  // Managers may view company evidence; keep forensic fields (they're managers).
  // Export is separately gated.
  return row;
}

/** Search Legal Evidence Vault (admin: all; manager: company). */
export const searchLegalEvidence = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  const q = request.data || {};

  let snap;
  if (
    ctx.isPlatformAdmin ||
    ctx.permissions.includes(PERMISSIONS.LEGAL_EVIDENCE_READ_ALL)
  ) {
    snap = await db.collection("legalEvidence").get();
  } else if (ctx.permissions.includes(PERMISSIONS.LEGAL_EVIDENCE_READ_COMPANY)) {
    if (!ctx.companyId) {
      throw new HttpsError("failed-precondition", "No company assignment.");
    }
    snap = await db
      .collection("legalEvidence")
      .where("companyId", "==", ctx.companyId)
      .get();
  } else {
    throw new HttpsError(
      "permission-denied",
      "Missing legal evidence read permission.",
    );
  }

  const contactName = String(q.contactName || "").trim().toLowerCase();
  const contactEmail = String(q.contactEmail || "").trim().toLowerCase();
  const representativeId = String(q.representativeId || "").trim();
  const companyId = String(q.companyId || "").trim();
  const invitationId = String(q.invitationId || "").trim();
  const sessionId = String(q.sessionId || "").trim();
  const ndaVersion = String(q.ndaVersion || "").trim().toLowerCase();
  const termsVersion = String(q.termsVersion || "").trim().toLowerCase();
  const privacyVersion = String(q.privacyVersion || "").trim().toLowerCase();
  const videoVersionId = String(q.videoVersionId || "").trim();
  const acceptedFrom = String(q.acceptedFrom || "").trim();
  const acceptedTo = String(q.acceptedTo || "").trim();
  const orphanedOnly = q.orphanedOnly === true;

  let rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as object) })) as Array<
    Record<string, unknown> & { id: string }
  >;

  rows = rows.filter((r) => {
    if (orphanedOnly && r.contactId != null) return false;
    if (companyId && String(r.companyId) !== companyId) return false;
    if (representativeId && String(r.representativeId) !== representativeId) {
      return false;
    }
    if (invitationId && String(r.invitationId) !== invitationId) return false;
    if (sessionId && String(r.sessionId) !== sessionId) return false;
    if (videoVersionId && String(r.videoVersionId) !== videoVersionId) return false;
    if (
      contactName &&
      !String(r.contactName || "")
        .toLowerCase()
        .includes(contactName)
    ) {
      return false;
    }
    if (
      contactEmail &&
      !String(r.contactEmail || "")
        .toLowerCase()
        .includes(contactEmail)
    ) {
      return false;
    }
    if (
      ndaVersion &&
      !String(r.ndaVersion || "")
        .toLowerCase()
        .includes(ndaVersion)
    ) {
      return false;
    }
    if (
      termsVersion &&
      !String(r.termsVersion || "")
        .toLowerCase()
        .includes(termsVersion)
    ) {
      return false;
    }
    if (
      privacyVersion &&
      !String(r.privacyVersion || "")
        .toLowerCase()
        .includes(privacyVersion)
    ) {
      return false;
    }
    const ts = String(r.acceptanceTimestamp || "");
    if (acceptedFrom && ts < acceptedFrom) return false;
    if (acceptedTo && ts > acceptedTo) return false;
    return true;
  });

  rows.sort((a, b) =>
    String(b.acceptanceTimestamp || "").localeCompare(
      String(a.acceptanceTimestamp || ""),
    ),
  );

  return {
    results: rows.map((r) => redactForManager(r)),
    count: rows.length,
  };
});

/** Get one Legal Evidence record with related session/invite timeline context. */
export const getLegalEvidence = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  const evidenceId = String(request.data?.evidenceId || "").trim();
  if (!evidenceId) throw new HttpsError("invalid-argument", "evidenceId required.");

  const snap = await db.collection("legalEvidence").doc(evidenceId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Legal evidence not found.");
  const evidence = { id: snap.id, ...snap.data()! } as Record<string, unknown> & {
    id: string;
    companyId: string;
    sessionId: string | null;
    invitationId: string;
    invitationSnapshot?: Record<string, unknown> | null;
  };

  if (!canReadEvidence(ctx, String(evidence.companyId))) {
    throw new HttpsError("permission-denied", "Legal evidence access denied.");
  }

  const sessionId =
    evidence.sessionId != null && String(evidence.sessionId).trim()
      ? String(evidence.sessionId)
      : null;
  const invitationId = String(evidence.invitationId);

  const [sessionSnap, inviteSnap, auditSnap] = await Promise.all([
    sessionId
      ? db.collection("presentationSessions").doc(sessionId).get()
      : Promise.resolve({ exists: false, id: "", data: () => undefined } as const),
    db.collection("invites").doc(invitationId).get(),
    sessionId
      ? db
          .collection("auditEvents")
          .where("sessionId", "==", sessionId)
          .limit(100)
          .get()
      : db
          .collection("auditEvents")
          .where("inviteId", "==", invitationId)
          .limit(100)
          .get(),
  ]);

  const session = sessionSnap.exists
    ? { id: sessionSnap.id, ...sessionSnap.data() }
    : null;
  const invitation = inviteSnap.exists
    ? { id: inviteSnap.id, ...inviteSnap.data() }
    : evidence.invitationSnapshot
      ? { ...evidence.invitationSnapshot, fromSnapshot: true }
      : null;
  const auditEvents = auditSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  return {
    evidence,
    session,
    invitation,
    auditEvents,
    timeline: {
      acceptanceTimestamp: evidence.acceptanceTimestamp,
      invitationOpenedAt: (session as { analytics?: { invitationOpenedAt?: string } } | null)
        ?.analytics?.invitationOpenedAt,
      presentationStarted:
        session &&
        ["in_progress", "completed", "closed"].includes(
          String((session as { status?: string }).status || ""),
        ),
      presentationCompletedAt: (session as { completedAt?: string } | null)?.completedAt,
      presentationDeleted: sessionId == null,
      videoVersionId: evidence.videoVersionId,
    },
  };
});

/** Export Audit Package (JSON + PDF summary). Platform admin / export permission. */
export const exportLegalEvidencePackage = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertCanExport(ctx);

  const evidenceId = String(request.data?.evidenceId || "").trim();
  if (!evidenceId) throw new HttpsError("invalid-argument", "evidenceId required.");

  const snap = await db.collection("legalEvidence").doc(evidenceId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Legal evidence not found.");
  const evidence = { id: snap.id, ...snap.data()! } as Record<string, unknown> & {
    id: string;
    companyId: string;
    sessionId: string | null;
    invitationId: string;
    invitationSnapshot?: Record<string, unknown> | null;
    legalAcceptanceIds?: string[];
    ndaDocumentId?: string;
    termsDocumentId?: string;
    privacyDocumentId?: string;
  };

  if (!canReadEvidence(ctx, String(evidence.companyId))) {
    throw new HttpsError("permission-denied", "Legal evidence access denied.");
  }

  const sessionId =
    evidence.sessionId != null && String(evidence.sessionId).trim()
      ? String(evidence.sessionId)
      : null;
  const invitationId = String(evidence.invitationId);

  const [sessionSnap, inviteSnap, auditSnap] = await Promise.all([
    sessionId
      ? db.collection("presentationSessions").doc(sessionId).get()
      : Promise.resolve({ exists: false, id: "", data: () => undefined } as const),
    db.collection("invites").doc(invitationId).get(),
    sessionId
      ? db
          .collection("auditEvents")
          .where("sessionId", "==", sessionId)
          .limit(200)
          .get()
      : db
          .collection("auditEvents")
          .where("inviteId", "==", invitationId)
          .limit(200)
          .get(),
  ]);

  const acceptanceIds = (evidence.legalAcceptanceIds as string[]) || [];
  const acceptances = [];
  for (const id of acceptanceIds) {
    const a = await db.collection("legalAcceptances").doc(id).get();
    if (a.exists) acceptances.push({ id: a.id, ...a.data() });
  }

  async function docMeta(id: string | undefined) {
    if (!id) return null;
    const d = await db.collection("legalDocuments").doc(id).get();
    if (!d.exists) return null;
    const data = d.data()!;
    return {
      id: d.id,
      type: data.type,
      versionLabel: data.versionLabel,
      title: data.title,
      contentSha256: data.contentSha256,
      effectiveDate: data.effectiveDate || null,
      // Body included for counsel package; evidence hashes remain authoritative.
      body: data.body,
    };
  }

  const [ndaDoc, termsDoc, privacyDoc] = await Promise.all([
    docMeta(evidence.ndaDocumentId as string | undefined),
    docMeta(evidence.termsDocumentId as string | undefined),
    docMeta(evidence.privacyDocumentId as string | undefined),
  ]);

  const session = sessionSnap.exists
    ? { id: sessionSnap.id, ...sessionSnap.data() }
    : null;
  const invitation = inviteSnap.exists
    ? {
        id: inviteSnap.id,
        ...inviteSnap.data(),
        tokenHash: undefined, // never export raw token material
      }
    : evidence.invitationSnapshot
      ? { ...evidence.invitationSnapshot, fromSnapshot: true }
      : null;
  const auditEvents = auditSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const jsonPackage = {
    packageType: "presentation_hub_legal_evidence_v1",
    exportedAt: new Date().toISOString(),
    exportedBy: ctx.uid,
    evidence,
    contactSnapshot: evidence.contactSnapshot,
    acceptedDocuments: {
      nda: ndaDoc,
      terms: termsDoc,
      privacy: privacyDoc,
    },
    documentHashes: {
      nda: evidence.ndaContentSha256,
      terms: evidence.termsContentSha256,
      privacy: evidence.privacyContentSha256,
    },
    invitationMetadata: invitation,
    sessionMetadata: session,
    auditMetadata: auditEvents,
    legalAcceptances: acceptances,
    presentationDeleted: sessionId == null,
  };

  const pdfLines = [
    "Presentation Hub — Legal Evidence Audit Summary",
    "==============================================",
    `Evidence ID: ${evidence.id}`,
    `Exported: ${jsonPackage.exportedAt}`,
    `Company: ${evidence.companyId}`,
    `Representative: ${evidence.representativeName} (${evidence.representativeId})`,
    `Invitation: ${evidence.invitationId}`,
    `Session: ${sessionId ?? "null (presentation deleted)"}`,
    `Contact (snapshot): ${evidence.contactName} <${evidence.contactEmail}>`,
    `Contact ID at acceptance: ${(evidence.contactSnapshot as { contactId?: string | null })?.contactId ?? "null"}`,
    `Current Contact ID: ${evidence.contactId ?? "null (orphaned)"}`,
    `Accepted: ${evidence.acceptanceTimestamp}`,
    `NDA ${evidence.ndaVersion} sha256=${evidence.ndaContentSha256}`,
    `Terms ${evidence.termsVersion} sha256=${evidence.termsContentSha256}`,
    `Privacy ${evidence.privacyVersion} sha256=${evidence.privacyContentSha256}`,
    `Video version: ${evidence.videoVersionId}`,
    `IP: ${evidence.ipAddress}`,
    `UA: ${String(evidence.userAgent || "").slice(0, 80)}`,
    `Audit signature: ${evidence.auditSignature}`,
    "This package is append-only evidence. Do not alter source records.",
  ];

  const pdfBase64 = buildSimplePdf(pdfLines).toString("base64");

  await writeAuditEvent({
    type: AUDIT_EVENT.LEGAL_EVIDENCE_EXPORTED,
    sessionId: sessionId || undefined,
    inviteId: invitationId,
    representativeId: String(evidence.representativeId),
    actorUid: ctx.uid,
    actorType: "administrator",
    payload: {
      evidenceId,
      companyId: evidence.companyId,
      presentationDeleted: sessionId == null,
    },
  });

  return {
    evidenceId,
    jsonPackage,
    auditSummaryPdfBase64: pdfBase64,
    auditSummaryPdfFileName: `legal-evidence-${evidenceId}.pdf`,
    jsonFileName: `legal-evidence-${evidenceId}.json`,
  };
});

/** Representative-safe legal completion status for a session (no forensic fields). */
export const getSessionLegalStatus = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.SESSIONS_READ_OWN);

  const sessionId = String(request.data?.sessionId || "").trim();
  if (!sessionId) throw new HttpsError("invalid-argument", "sessionId required.");

  const sessionSnap = await db.collection("presentationSessions").doc(sessionId).get();
  if (!sessionSnap.exists) throw new HttpsError("not-found", "Session not found.");
  const session = sessionSnap.data()!;

  if (
    !ctx.isPlatformAdmin &&
    session.representativeId !== ctx.uid &&
    !(
      ctx.permissions.includes(PERMISSIONS.SESSIONS_READ_COMPANY) &&
      ctx.companyId &&
      session.companyId === ctx.companyId
    )
  ) {
    throw new HttpsError("permission-denied", "Session access denied.");
  }

  const accepted = Boolean(session.legalAcceptanceId);
  return {
    sessionId,
    legalAccepted: accepted,
    ndaAccepted: accepted,
    termsAccepted: accepted,
    privacyAccepted: accepted,
    acceptanceTimestamp: accepted
      ? session.updatedAt || null
      : null,
    ndaVersionId: session.ndaVersionId || null,
    termsVersionId: session.termsVersionId || null,
    privacyVersionId: session.privacyVersionId || null,
  };
});
