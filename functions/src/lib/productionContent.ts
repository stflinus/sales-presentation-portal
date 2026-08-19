import { HttpsError } from "firebase-functions/v2/https";
import {
  CONTENT_STATUS,
  LEGAL_DOC_TYPE,
  VIDEO_STATUS,
  type LegalDocType,
} from "../shared";
import { db } from "./firebase";
import { getCompany } from "./settings";

export interface ContentReadiness {
  ready: boolean;
  missing: string[];
  companyId?: string;
  activeNdaId?: string;
  activeTermsId?: string;
  activePrivacyId?: string;
  activeVideoId?: string;
}

function isUsablePublishedLegal(
  data: Record<string, unknown> | undefined,
): boolean {
  if (!data) return false;
  if (data.status !== CONTENT_STATUS.ACTIVE) return false;
  if (data.isPlaceholder === true) return false;
  return true;
}

function isUsableActiveVideo(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  if (data.status !== VIDEO_STATUS.ACTIVE || data.active !== true) return false;
  if (data.isPlaceholder === true || data.deleted === true) return false;
  if (data.fileSize == null && data.sizeBytes == null) return false;
  return true;
}

export async function assessContentReadinessForCompany(
  companyId: string,
): Promise<ContentReadiness> {
  const missing: string[] = [];
  let company;
  try {
    company = await getCompany(companyId);
  } catch {
    return { ready: false, missing: ["Company record missing"], companyId };
  }
  if (company.status !== "active") {
    return { ready: false, missing: ["Company is inactive"], companyId };
  }

  const checks: Array<{ type: LegalDocType; id: string; label: string }> = [
    {
      type: LEGAL_DOC_TYPE.NDA,
      id: company.activeNdaId || "",
      label: "NDA (active published version)",
    },
    {
      type: LEGAL_DOC_TYPE.TERMS,
      id: company.activeTermsId || "",
      label: "Terms & Conditions (active published version)",
    },
    {
      type: LEGAL_DOC_TYPE.PRIVACY,
      id: company.activePrivacyId || "",
      label: "Privacy Policy (active published version)",
    },
  ];

  for (const check of checks) {
    if (!check.id) {
      missing.push(check.label);
      continue;
    }
    const snap = await db.collection("legalDocuments").doc(check.id).get();
    const data = snap.data() as Record<string, unknown> | undefined;
    if (!isUsablePublishedLegal(data)) {
      missing.push(
        `${check.label} — configured document is missing, placeholder, or not active`,
      );
    } else if (data?.companyId && data.companyId !== companyId) {
      missing.push(`${check.label} — document company mismatch`);
    }
  }

  let resolvedVideoId: string | null = null;
  const configuredVideoId = company.activeVideoId || "";
  if (configuredVideoId) {
    const videoSnap = await db.collection("videos").doc(configuredVideoId).get();
    const data = videoSnap.data() as Record<string, unknown> | undefined;
    if (
      isUsableActiveVideo(data) &&
      (!data?.companyId || data.companyId === companyId)
    ) {
      resolvedVideoId = configuredVideoId;
    }
  }
  if (!resolvedVideoId) {
    const activeSnap = await db
      .collection("videos")
      .where("companyId", "==", companyId)
      .where("status", "==", VIDEO_STATUS.ACTIVE)
      .limit(20)
      .get();
    for (const doc of activeSnap.docs) {
      if (isUsableActiveVideo(doc.data() as Record<string, unknown>)) {
        resolvedVideoId = doc.id;
        break;
      }
    }
  }
  if (!resolvedVideoId) {
    missing.push("Active video (upload and activate at least one video in Video Library)");
  }

  return {
    ready: missing.length === 0,
    missing,
    companyId,
    activeNdaId: company.activeNdaId,
    activeTermsId: company.activeTermsId,
    activePrivacyId: company.activePrivacyId,
    activeVideoId: resolvedVideoId || company.activeVideoId,
  };
}

export async function assessContentReadiness(): Promise<ContentReadiness> {
  const settingsSnap = await db.collection("settings").doc("portal").get();
  if (!settingsSnap.exists) {
    return {
      ready: false,
      missing: ["Portal settings (run bootstrap / company migration)"],
    };
  }
  const settings = settingsSnap.data() as Record<string, unknown>;
  const companyId = String(settings.defaultCompanyId || "");
  if (companyId) {
    return assessContentReadinessForCompany(companyId);
  }
  return {
    ready: false,
    missing: ["Default company not configured"],
  };
}

export async function assertProductionContentReady(
  companyId?: string,
): Promise<ContentReadiness> {
  const readiness = companyId
    ? await assessContentReadinessForCompany(companyId)
    : await assessContentReadiness();
  if (!readiness.ready) {
    throw new HttpsError(
      "failed-precondition",
      [
        "Cannot create client invitations until published content is ready.",
        "Missing or invalid:",
        ...readiness.missing.map((m) => `• ${m}`),
        "Publish NDA, Terms & Conditions, and Privacy Policy, and activate a production video.",
      ].join("\n"),
    );
  }
  return readiness;
}
