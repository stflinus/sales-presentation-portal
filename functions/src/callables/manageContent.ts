import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  AUDIT_EVENT,
  CONTENT_STATUS,
  LEGAL_DOC_TYPE,
  PERMISSIONS,
  type LegalDocType,
} from "../shared";
import {
  assertHasPermission,
  loadStaffContext,
  requirePermission,
  resolveActingCompanyId,
} from "../lib/authz";
import { writeAuditEvent } from "../lib/audit";
import { sha256Hex } from "../lib/crypto";
import { db } from "../lib/firebase";
import { getPortalSettings } from "../lib/settings";

const LEGAL_TYPES = new Set<string>(Object.values(LEGAL_DOC_TYPE));

/** Create a new legal document version and optionally activate it. */
export const publishLegalDocument = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.LEGAL_MANAGE);

  let requestedCompanyId =
    typeof request.data?.companyId === "string" ? request.data.companyId : null;
  if (!requestedCompanyId && ctx.isPlatformAdmin && !ctx.companyId) {
    const settings = await getPortalSettings();
    requestedCompanyId = settings.defaultCompanyId || null;
  }
  const companyId = resolveActingCompanyId(ctx, requestedCompanyId);
  const uid = ctx.uid;

  const type = String(request.data?.type || "") as LegalDocType;
  const title = String(request.data?.title || "").trim();
  const body = String(request.data?.body || "");
  const versionLabel = String(request.data?.versionLabel || "").trim();
  const activate = request.data?.activate !== false;

  if (!LEGAL_TYPES.has(type)) {
    throw new HttpsError("invalid-argument", "type must be nda|terms|privacy.");
  }
  if (!title || !body || !versionLabel) {
    throw new HttpsError("invalid-argument", "title, body, versionLabel required.");
  }
  if (/\[PLACEHOLDER/i.test(body) || /placeholder must be replaced/i.test(body)) {
    throw new HttpsError(
      "invalid-argument",
      "Document body still looks like a placeholder. Paste counsel-approved wording before publishing.",
    );
  }

  const contentSha256 = sha256Hex(body);
  const ref = db.collection("legalDocuments").doc();
  const nowIso = new Date().toISOString();
  const effectiveDate =
    typeof request.data?.effectiveDate === "string"
      ? String(request.data.effectiveDate).trim() || null
      : null;
  const originalPdfPath =
    typeof request.data?.originalPdfPath === "string"
      ? String(request.data.originalPdfPath).trim() || null
      : null;

  await db.runTransaction(async (tx) => {
    let previousVersionId: string | null = null;

    if (activate) {
      const active = await tx.get(
        db
          .collection("legalDocuments")
          .where("type", "==", type)
          .where("companyId", "==", companyId)
          .where("status", "==", CONTENT_STATUS.ACTIVE)
          .limit(20),
      );
      previousVersionId = active.docs[0]?.id ?? null;
      for (const docSnap of active.docs) {
        tx.update(docSnap.ref, {
          status: CONTENT_STATUS.ARCHIVED,
          active: false,
          archivedAt: nowIso,
        });
      }
    }

    tx.set(ref, {
      id: ref.id,
      type,
      versionLabel,
      title,
      body,
      contentSha256,
      companyId,
      status: activate ? CONTENT_STATUS.ACTIVE : CONTENT_STATUS.DRAFT,
      isPlaceholder: false,
      active: activate,
      createdAt: nowIso,
      createdBy: uid,
      activatedAt: activate ? nowIso : null,
      effectiveDate,
      previousVersionId,
      originalPdfPath,
      createdAtServer: FieldValue.serverTimestamp(),
    });

    if (activate) {
      const settingsField =
        type === "nda"
          ? "activeNdaId"
          : type === "terms"
            ? "activeTermsId"
            : "activePrivacyId";
      tx.set(
        db.collection("settings").doc("portal"),
        { [settingsField]: ref.id, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      tx.set(
        db.collection("companies").doc(companyId),
        {
          [settingsField]: ref.id,
          updatedAt: nowIso,
          updatedAtServer: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.ADMINISTRATOR_ACTION,
    actorUid: uid,
    actorType: "administrator",
    payload: {
      action: "publish_legal_document",
      documentId: ref.id,
      type,
      companyId,
      activate,
      contentSha256,
    },
  });

  return { id: ref.id, contentSha256, companyId, activated: activate };
});

/** Register an uploaded Storage object as the active video (or draft). */
export const registerVideo = onCall(async (request) => {
  const uid = requirePermission(request, PERMISSIONS.VIDEOS_MANAGE);
  const title = String(request.data?.title || "Sales Presentation").trim();
  const storagePath = String(request.data?.storagePath || "").trim();
  const durationSeconds =
    request.data?.durationSeconds == null
      ? null
      : Number(request.data.durationSeconds);
  const activate = request.data?.activate !== false;

  if (!storagePath.startsWith("videos/")) {
    throw new HttpsError(
      "invalid-argument",
      "storagePath must be under videos/.",
    );
  }

  const ref = db.collection("videos").doc();
  const nowIso = new Date().toISOString();

  await db.runTransaction(async (tx) => {
    if (activate) {
      const active = await tx.get(
        db
          .collection("videos")
          .where("status", "==", CONTENT_STATUS.ACTIVE)
          .limit(20),
      );
      for (const docSnap of active.docs) {
        tx.update(docSnap.ref, {
          status: CONTENT_STATUS.ARCHIVED,
          archivedAt: nowIso,
        });
      }
    }

    tx.set(ref, {
      id: ref.id,
      title,
      storagePath,
      status: activate ? CONTENT_STATUS.ACTIVE : CONTENT_STATUS.DRAFT,
      isPlaceholder: false,
      durationSeconds,
      contentType: "video/mp4",
      sizeBytes: null,
      campaignIds: [],
      createdAt: nowIso,
      createdBy: uid,
      activatedAt: activate ? nowIso : null,
      createdAtServer: FieldValue.serverTimestamp(),
    });

    if (activate) {
      tx.set(
        db.collection("settings").doc("portal"),
        {
          activeVideoId: ref.id,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.ADMINISTRATOR_ACTION,
    actorUid: uid,
    actorType: "administrator",
    payload: {
      action: "register_video",
      videoId: ref.id,
      storagePath,
      activate,
    },
  });

  return { id: ref.id, storagePath, activated: activate };
});
