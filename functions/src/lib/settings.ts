import { HttpsError } from "firebase-functions/v2/https";
import {
  CONTENT_STATUS,
  VIDEO_STATUS,
  type LegalDocType,
  type LegalDocument,
  type PortalSettings,
  type Company,
} from "../shared";
import { db } from "./firebase";

export async function getPortalSettings(): Promise<PortalSettings & { id: string }> {
  const snap = await db.collection("settings").doc("portal").get();
  if (!snap.exists) {
    throw new HttpsError(
      "failed-precondition",
      "Portal settings missing. Run bootstrapAdmin first.",
    );
  }
  return { id: snap.id, ...(snap.data() as PortalSettings) };
}

export async function getCompany(companyId: string): Promise<Company> {
  const snap = await db.collection("companies").doc(companyId).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", `Company not found: ${companyId}`);
  }
  return { id: snap.id, ...(snap.data() as Omit<Company, "id">) };
}

function assertPublishedLegal(doc: LegalDocument, type: LegalDocType): void {
  if (doc.status !== CONTENT_STATUS.ACTIVE || doc.isPlaceholder) {
    throw new HttpsError(
      "failed-precondition",
      `Active published ${type} document required. Placeholder or draft documents cannot be shown to clients.`,
    );
  }
}

export async function getActiveLegalDocsForCompany(companyId: string): Promise<{
  company: Company;
  docs: LegalDocument[];
}> {
  const company = await getCompany(companyId);
  if (company.status !== "active") {
    throw new HttpsError("failed-precondition", "Company is inactive.");
  }
  const ids = [
    { type: "nda" as LegalDocType, id: company.activeNdaId },
    { type: "terms" as LegalDocType, id: company.activeTermsId },
    { type: "privacy" as LegalDocType, id: company.activePrivacyId },
  ];
  const docs: LegalDocument[] = [];
  for (const item of ids) {
    if (!item.id) {
      throw new HttpsError(
        "failed-precondition",
        `No active ${item.type} configured for this company.`,
      );
    }
    const snap = await db.collection("legalDocuments").doc(item.id).get();
    if (!snap.exists) {
      throw new HttpsError(
        "failed-precondition",
        `Active ${item.type} document missing (${item.id}).`,
      );
    }
    const data = { id: snap.id, ...(snap.data() as Omit<LegalDocument, "id">) };
    if (data.companyId && data.companyId !== companyId) {
      throw new HttpsError(
        "failed-precondition",
        `Legal document ${item.type} does not belong to this company.`,
      );
    }
    assertPublishedLegal(data, item.type);
    docs.push(data);
  }
  return { company, docs };
}

/** @deprecated Prefer getActiveLegalDocsForCompany — kept for bootstrap/migration */
export async function getActiveLegalDocs(): Promise<{
  settings: PortalSettings & { id: string };
  docs: LegalDocument[];
}> {
  const settings = await getPortalSettings();
  const companyId = settings.defaultCompanyId;
  if (companyId) {
    const { docs } = await getActiveLegalDocsForCompany(companyId);
    return { settings, docs };
  }
  const ids = [
    { type: "nda" as LegalDocType, id: settings.activeNdaId },
    { type: "terms" as LegalDocType, id: settings.activeTermsId },
    { type: "privacy" as LegalDocType, id: settings.activePrivacyId },
  ];
  const docs: LegalDocument[] = [];
  for (const item of ids) {
    if (!item.id) {
      throw new HttpsError(
        "failed-precondition",
        `No active ${item.type} configured. Publish a non-placeholder version first.`,
      );
    }
    const snap = await db.collection("legalDocuments").doc(item.id).get();
    if (!snap.exists) {
      throw new HttpsError(
        "failed-precondition",
        `Active ${item.type} document missing (${item.id}).`,
      );
    }
    const data = { id: snap.id, ...(snap.data() as Omit<LegalDocument, "id">) };
    assertPublishedLegal(data, item.type);
    docs.push(data);
  }
  return { settings, docs };
}

export async function getActiveVideoForCompany(companyId: string) {
  const company = await getCompany(companyId);
  if (company.status !== "active") {
    throw new HttpsError("failed-precondition", "Company is inactive.");
  }
  if (!company.activeVideoId) {
    throw new HttpsError(
      "failed-precondition",
      "No active video configured for this company.",
    );
  }
  const snap = await db.collection("videos").doc(company.activeVideoId).get();
  if (!snap.exists) {
    throw new HttpsError("failed-precondition", "Active video missing.");
  }
  const data = snap.data()!;
  if (
    data.status !== VIDEO_STATUS.ACTIVE ||
    data.active !== true ||
    data.isPlaceholder === true ||
    data.deleted === true
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Configured video is not active. Activate a production video in the Video Library.",
    );
  }
  if (data.companyId && data.companyId !== companyId) {
    throw new HttpsError(
      "failed-precondition",
      "Active video does not belong to this company.",
    );
  }
  return { id: snap.id, ...data, company };
}

export async function getActiveVideo() {
  const settings = await getPortalSettings();
  if (settings.defaultCompanyId) {
    return getActiveVideoForCompany(settings.defaultCompanyId);
  }
  if (!settings.activeVideoId) {
    throw new HttpsError(
      "failed-precondition",
      "No active video configured. Register and activate a production video first.",
    );
  }
  const snap = await db.collection("videos").doc(settings.activeVideoId).get();
  if (!snap.exists) {
    throw new HttpsError("failed-precondition", "Active video missing.");
  }
  const data = snap.data()!;
  if (
    data.status !== VIDEO_STATUS.ACTIVE ||
    data.active !== true ||
    data.isPlaceholder === true ||
    data.deleted === true
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Configured video is not active. Activate a production video in the Video Library.",
    );
  }
  return { id: snap.id, ...data, settings };
}
