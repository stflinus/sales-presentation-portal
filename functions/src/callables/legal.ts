import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  ACTIVITY_EVENT,
  ACTIVITY_SEVERITY,
  APP_VERSION,
  AUDIT_EVENT,
  INVITE_STATUS,
  SESSION_STATUS,
  type LegalDocType,
  type LegalDocument,
  isTimeLimitedPolicy,
} from "../shared";
import { requireClientSession } from "../lib/authz";
import { writeAnalyticsEvent, writeAuditEvent } from "../lib/audit";
import { writePresentationActivity } from "../lib/presentationActivity";
import { buildAuditSignature, sha256Hex } from "../lib/crypto";
import { db } from "../lib/firebase";
import { getActiveLegalDocs, getActiveLegalDocsForCompany, getPortalSettings } from "../lib/settings";
import { createLegalEvidenceRecord, invitationSnapshotFromInvite } from "../lib/legalEvidence";
import { clientIpFromRequest, parseUserAgent } from "../lib/ua";
import {
  genericAccessUnavailableMessage,
  sessionSingleViewBlocked,
} from "../lib/presentationPolicy";

function mapLegalDoc(d: LegalDocument) {
  return {
    id: d.id,
    type: d.type as LegalDocType,
    versionLabel: d.versionLabel,
    title: d.title,
    body: d.body,
    contentSha256: d.contentSha256,
    effectiveDate: d.effectiveDate || null,
  };
}

export const getLegalBundle = onCall(async (request) => {
  const sessionId = String(request.data?.sessionId || "");
  requireClientSession(request, sessionId);

  const sessionSnap = await db.collection("presentationSessions").doc(sessionId).get();
  if (!sessionSnap.exists) throw new HttpsError("not-found", "Session not found.");
  const session = sessionSnap.data()!;

  if (
    sessionSingleViewBlocked(session) &&
    !isTimeLimitedPolicy(session.accessPolicy)
  ) {
    throw new HttpsError(
      "failed-precondition",
      genericAccessUnavailableMessage(),
    );
  }

  const companyId = String(session.companyId || "");
  const { docs } = companyId
    ? await getActiveLegalDocsForCompany(companyId)
    : await getActiveLegalDocs();
  const ip = clientIpFromRequest(request.rawRequest?.headers["x-forwarded-for"]);

  await writeAuditEvent({
    type: AUDIT_EVENT.LEGAL_DISPLAYED,
    sessionId,
    inviteId: session.inviteId,
    representativeId: session.representativeId,
    actorUid: request.auth!.uid,
    actorType: "client",
    ipAddress: ip,
    payload: {
      documentIds: docs.map((d) => d.id),
      companyId: companyId || null,
    },
  });
  await writePresentationActivity({
    sessionId,
    inviteId: session.inviteId,
    companyId: companyId || null,
    representativeId: session.representativeId,
    type: ACTIVITY_EVENT.LEGAL_LOADED,
    severity: ACTIVITY_SEVERITY.SUCCESS,
    description: "Required legal documents were loaded for review.",
    env: parseUserAgent(request.rawRequest?.headers["user-agent"] || ""),
    ipAddress: ip,
    actorType: "client",
    actorUid: request.auth!.uid,
  });

  const openedAt = session.analytics?.invitationOpenedAt as string | undefined;
  if (openedAt && session.analytics?.timeUntilNdaMs == null) {
    const timeUntilNdaMs = Date.now() - new Date(openedAt).getTime();
    await sessionSnap.ref.update({
      "analytics.timeUntilNdaMs": timeUntilNdaMs,
      updatedAt: new Date().toISOString(),
      updatedAtServer: FieldValue.serverTimestamp(),
    });
    await writeAnalyticsEvent({
      sessionId,
      representativeId: session.representativeId,
      metric: "time_until_nda_ms",
      value: timeUntilNdaMs,
      videoVersionId: session.videoId,
    });
  }

  return {
    documents: docs.map(mapLegalDoc),
  };
});

interface AcceptLegalRequest {
  sessionId: string;
  ndaChecked: boolean;
  termsPrivacyChecked: boolean;
  screenResolution?: string;
}

export const acceptLegal = onCall(async (request) => {
  const data = request.data as AcceptLegalRequest;
  const sessionId = String(data.sessionId || "");
  requireClientSession(request, sessionId);

  if (data.ndaChecked !== true || data.termsPrivacyChecked !== true) {
    throw new HttpsError(
      "invalid-argument",
      "Both legal acceptance checkboxes are required.",
    );
  }

  const sessionRef = db.collection("presentationSessions").doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) throw new HttpsError("not-found", "Session not found.");
  const session = sessionSnap.data()!;

  if (
    sessionSingleViewBlocked(session) &&
    !isTimeLimitedPolicy(session.accessPolicy)
  ) {
    throw new HttpsError(
      "failed-precondition",
      genericAccessUnavailableMessage(),
    );
  }

  if (
    session.status === SESSION_STATUS.LEGAL_ACCEPTED ||
    session.status === SESSION_STATUS.IN_PROGRESS
  ) {
    return {
      ok: true,
      legalAcceptanceId: session.legalAcceptanceId,
      legalAcceptanceIds: session.legalAcceptanceIds || [],
    };
  }

  if (session.status !== SESSION_STATUS.OPENED && session.status !== SESSION_STATUS.PENDING) {
    throw new HttpsError("failed-precondition", "Session cannot accept legal documents.");
  }

  let companyId = String(session.companyId || "");
  const { docs } = companyId
    ? await getActiveLegalDocsForCompany(companyId)
    : await getActiveLegalDocs();
  const byType = Object.fromEntries(docs.map((d) => [d.type, d])) as Record<
    string,
    LegalDocument
  >;
  const nda = byType.nda;
  const terms = byType.terms;
  const privacy = byType.privacy;
  if (!nda || !terms || !privacy) {
    throw new HttpsError("failed-precondition", "Active NDA, Terms, and Privacy required.");
  }
  if (nda.isPlaceholder || terms.isPlaceholder || privacy.isPlaceholder) {
    throw new HttpsError(
      "failed-precondition",
      "Placeholder legal documents cannot be accepted.",
    );
  }

  if (!companyId) {
    const settings = await getPortalSettings();
    companyId = settings.defaultCompanyId || "unknown";
  }
  const ip = clientIpFromRequest(request.rawRequest?.headers["x-forwarded-for"]);
  const env = parseUserAgent(request.rawRequest?.headers["user-agent"] || "");
  const screenResolution = String(data.screenResolution || "unknown").slice(0, 64);
  const acceptedAtUtc = new Date().toISOString();
  const batchId = db.collection("legalAcceptances").doc().id;

  const ordered: LegalDocument[] = [nda, terms, privacy];
  const acceptanceRefs = ordered.map(() => db.collection("legalAcceptances").doc());

  const auditSignature = buildAuditSignature([
    batchId,
    sessionId,
    session.inviteId,
    session.representativeId,
    session.clientEmail,
    nda.id,
    terms.id,
    privacy.id,
    ...ordered.map((d) => d.contentSha256 || sha256Hex(String(d.body))),
    acceptedAtUtc,
    ip,
    env.userAgent,
    screenResolution,
    session.videoId,
    APP_VERSION,
  ]);

  const records = ordered.map((docItem, index) => {
    const ref = acceptanceRefs[index]!;
    return {
      ref,
      data: {
        id: ref.id,
        documentType: docItem.type,
        documentVersion: docItem.versionLabel,
        effectiveDate: docItem.effectiveDate || null,
        contentSha256: docItem.contentSha256 || sha256Hex(String(docItem.body)),
        documentId: docItem.id,
        acceptanceTimestamp: acceptedAtUtc,
        invitationId: session.inviteId,
        presentationSessionId: sessionId,
        representativeId: session.representativeId,
        companyId,
        contactId: session.contactId || null,
        clientName: session.clientName,
        clientEmail: session.clientEmail,
        ipAddress: ip,
        browser: env.browser,
        operatingSystem: env.operatingSystem,
        deviceType: env.deviceType,
        screenResolution,
        userAgent: env.userAgent,
        acceptanceBatchId: batchId,
        representativeName: session.representativeName,
        ndaVersionId: nda.id,
        termsVersionId: terms.id,
        privacyVersionId: privacy.id,
        agreementChecked: true as const,
        acceptedAtUtc,
        videoAssignedId: session.videoId,
        applicationVersion: APP_VERSION,
        auditSignature,
        immutable: true as const,
        createdAtServer: FieldValue.serverTimestamp(),
        acceptedAtServer: FieldValue.serverTimestamp(),
      },
    };
  });

  const legalAcceptanceIds = records.map((r) => r.ref.id);

  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(sessionRef);
    const freshStatus = fresh.data()?.status;
    if (
      freshStatus === SESSION_STATUS.LEGAL_ACCEPTED ||
      freshStatus === SESSION_STATUS.IN_PROGRESS ||
      freshStatus === SESSION_STATUS.COMPLETED
    ) {
      return;
    }
    for (const record of records) {
      tx.set(record.ref, record.data);
    }
    tx.update(sessionRef, {
      status: SESSION_STATUS.LEGAL_ACCEPTED,
      legalAcceptanceId: batchId,
      legalAcceptanceIds,
      ndaVersionId: nda.id,
      termsVersionId: terms.id,
      privacyVersionId: privacy.id,
      updatedAt: acceptedAtUtc,
      updatedAtServer: FieldValue.serverTimestamp(),
    });
    tx.update(db.collection("invites").doc(session.inviteId), {
      status: INVITE_STATUS.ACCEPTED,
    });
  });

  const auditEventId = await writeAuditEvent({
    type: AUDIT_EVENT.LEGAL_ACCEPTED,
    sessionId,
    inviteId: session.inviteId,
    representativeId: session.representativeId,
    actorUid: request.auth!.uid,
    actorType: "client",
    ipAddress: ip,
    payload: {
      legalAcceptanceId: batchId,
      legalAcceptanceIds,
      auditSignature,
      ndaVersionId: nda.id,
      termsVersionId: terms.id,
      privacyVersionId: privacy.id,
    },
  });

  for (const item of [
    { type: ACTIVITY_EVENT.NDA_ACCEPTED, description: "NDA accepted." },
    { type: ACTIVITY_EVENT.TERMS_ACCEPTED, description: "Terms & Conditions accepted." },
    { type: ACTIVITY_EVENT.PRIVACY_ACCEPTED, description: "Privacy Policy accepted." },
  ] as const) {
    await writePresentationActivity({
      sessionId,
      inviteId: session.inviteId,
      companyId: (session.companyId as string) || null,
      representativeId: session.representativeId,
      type: item.type,
      severity: ACTIVITY_SEVERITY.SUCCESS,
      description: item.description,
      env,
      ipAddress: ip,
      actorType: "client",
      actorUid: request.auth!.uid,
    });
  }
  await writePresentationActivity({
    sessionId,
    inviteId: session.inviteId,
    companyId: (session.companyId as string) || null,
    representativeId: session.representativeId,
    type: ACTIVITY_EVENT.LEGAL_ACCEPTED,
    severity: ACTIVITY_SEVERITY.SUCCESS,
    description: "All required legal documents were accepted.",
    env,
    ipAddress: ip,
    actorType: "client",
    actorUid: request.auth!.uid,
  });

  // Append-only Legal Evidence Vault record (separate from CRM Contact lifecycle).
  try {
    const after = await sessionRef.get();
    const alreadyAccepted =
      after.data()?.legalAcceptanceId === batchId ||
      (Array.isArray(after.data()?.legalAcceptanceIds) &&
        after.data()?.legalAcceptanceIds?.[0] === legalAcceptanceIds[0]);
    if (alreadyAccepted) {
      const existing = await db
        .collection("legalEvidence")
        .where("acceptanceBatchId", "==", batchId)
        .limit(1)
        .get();
      if (existing.empty) {
        const inviteSnap = await db.collection("invites").doc(session.inviteId).get();
        const evidenceId = await createLegalEvidenceRecord({
          companyId,
          representativeId: session.representativeId,
          representativeName: String(session.representativeName || ""),
          invitationId: session.inviteId,
          sessionId,
          contactId: session.contactId || null,
          contactName: String(session.clientName || ""),
          contactEmail: String(session.clientEmail || ""),
          invitationSnapshot: invitationSnapshotFromInvite(
            session.inviteId,
            inviteSnap.exists ? (inviteSnap.data() as Record<string, unknown>) : null,
          ),
          nda,
          terms,
          privacy,
          acceptanceTimestamp: acceptedAtUtc,
          legalAcceptanceIds,
          acceptanceBatchId: batchId,
          auditSignature,
          auditEventIds: [auditEventId],
          ipAddress: ip,
          browser: env.browser,
          operatingSystem: env.operatingSystem,
          deviceType: env.deviceType,
          userAgent: env.userAgent,
          screenResolution,
          videoVersionId: String(session.videoId || ""),
          applicationVersion: APP_VERSION,
          ndaSha256: String(nda.contentSha256 || sha256Hex(String(nda.body))),
          termsSha256: String(terms.contentSha256 || sha256Hex(String(terms.body))),
          privacySha256: String(
            privacy.contentSha256 || sha256Hex(String(privacy.body)),
          ),
        });
        await writeAuditEvent({
          type: AUDIT_EVENT.LEGAL_EVIDENCE_CREATED,
          sessionId,
          inviteId: session.inviteId,
          representativeId: session.representativeId,
          actorUid: request.auth!.uid,
          actorType: "system",
          payload: { evidenceId, acceptanceBatchId: batchId },
        });
      }
    }
  } catch {
    // Evidence write failure must not block client acceptance success path;
    // acceptance docs already committed. Ops can backfill from legalAcceptances.
  }

  return {
    ok: true,
    legalAcceptanceId: batchId,
    legalAcceptanceIds,
    acceptedAtUtc,
  };
});

/** Informational-only open/close logging for legal document modals. */
export const recordLegalDocumentView = onCall(async (request) => {
  const sessionId = String(request.data?.sessionId || "");
  requireClientSession(request, sessionId);

  const documentType = String(request.data?.documentType || "") as LegalDocType;
  const action = String(request.data?.action || "");
  const viewEventId = String(request.data?.viewEventId || "").trim();

  if (!["nda", "terms", "privacy"].includes(documentType)) {
    throw new HttpsError("invalid-argument", "documentType must be nda|terms|privacy.");
  }
  if (action !== "open" && action !== "close") {
    throw new HttpsError("invalid-argument", "action must be open|close.");
  }

  const sessionSnap = await db.collection("presentationSessions").doc(sessionId).get();
  if (!sessionSnap.exists) throw new HttpsError("not-found", "Session not found.");
  const session = sessionSnap.data()!;

  const companyId = String(session.companyId || "");
  const { docs } = companyId
    ? await getActiveLegalDocsForCompany(companyId)
    : await getActiveLegalDocs();
  const docItem = docs.find((d) => d.type === documentType);
  if (!docItem) {
    throw new HttpsError("failed-precondition", "Active legal document missing.");
  }

  const nowIso = new Date().toISOString();

  if (action === "open") {
    const ref = db.collection("legalDocumentViews").doc();
    await ref.set({
      id: ref.id,
      documentType,
      documentId: docItem.id,
      documentVersion: docItem.versionLabel,
      presentationSessionId: sessionId,
      invitationId: session.inviteId,
      openedAtUtc: nowIso,
      closedAtUtc: null,
      informationalOnly: true,
      createdAtServer: FieldValue.serverTimestamp(),
    });
    await writeAuditEvent({
      type: AUDIT_EVENT.LEGAL_DOCUMENT_VIEWED,
      sessionId,
      inviteId: session.inviteId,
      representativeId: session.representativeId,
      actorUid: request.auth!.uid,
      actorType: "client",
      payload: {
        action: "open",
        documentType,
        documentId: docItem.id,
        viewEventId: ref.id,
        openedAtUtc: nowIso,
      },
    });
    return { ok: true, viewEventId: ref.id, openedAtUtc: nowIso };
  }

  if (!viewEventId) {
    throw new HttpsError("invalid-argument", "viewEventId required to close a view.");
  }
  const viewRef = db.collection("legalDocumentViews").doc(viewEventId);
  const viewSnap = await viewRef.get();
  if (!viewSnap.exists) {
    throw new HttpsError("not-found", "View event not found.");
  }
  const view = viewSnap.data()!;
  if (view.presentationSessionId !== sessionId) {
    throw new HttpsError("permission-denied", "View event does not belong to this session.");
  }
  await viewRef.update({
    closedAtUtc: nowIso,
    updatedAtServer: FieldValue.serverTimestamp(),
  });
  await writeAuditEvent({
    type: AUDIT_EVENT.LEGAL_DOCUMENT_VIEWED,
    sessionId,
    inviteId: session.inviteId,
    representativeId: session.representativeId,
    actorUid: request.auth!.uid,
    actorType: "client",
    payload: {
      action: "close",
      documentType,
      documentId: docItem.id,
      viewEventId,
      openedAtUtc: view.openedAtUtc,
      closedAtUtc: nowIso,
    },
  });
  return { ok: true, viewEventId, closedAtUtc: nowIso };
});
