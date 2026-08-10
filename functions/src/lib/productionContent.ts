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

  const videoId = company.activeVideoId || "";
  if (!videoId) {
    missing.push("Active video (upload and activate in Video Library)");
  } else {
    const videoSnap = await db.collection("videos").doc(videoId).get();
    const data = videoSnap.data() as Record<string, unknown> | undefined;
    if (!isUsableActiveVideo(data)) {
      missing.push(
        "Active video — upload an MP4 and Activate it in the Video Library",
      );
    } else if (data?.companyId && data.companyId !== companyId) {
      missing.push("Active video — company mismatch");
    }
  }

  return {
    ready: missing.length === 0,
    missing,
    companyId,
    activeNdaId: company.activeNdaId,
    activeTermsId: company.activeTermsId,
    activePrivacyId: company.activePrivacyId,
    activeVideoId: company.activeVideoId,
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
