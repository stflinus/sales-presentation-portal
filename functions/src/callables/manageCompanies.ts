import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { AUDIT_EVENT, PERMISSIONS, type CompanyStatus } from "../shared";
import {
  assertHasPermission,
  loadStaffContext,
  resolveActingCompanyId,
} from "../lib/authz";
import { writeAuditEvent } from "../lib/audit";
import { db } from "../lib/firebase";
import { getPortalSettings } from "../lib/settings";

function nowIso() {
  return new Date().toISOString();
}

/** List companies (platform admin) or the caller's company. */
export const listCompanies = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  if (ctx.isPlatformAdmin || ctx.permissions.includes(PERMISSIONS.COMPANIES_MANAGE)) {
    assertHasPermission(ctx, PERMISSIONS.COMPANIES_MANAGE);
    const snap = await db.collection("companies").orderBy("name").get();
    return {
      companies: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
    };
  }
  if (!ctx.companyId) {
    throw new HttpsError("failed-precondition", "No company assignment.");
  }
  const snap = await db.collection("companies").doc(ctx.companyId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Company not found.");
  return { companies: [{ id: snap.id, ...snap.data() }] };
});

/** Create a company (platform administrator only). */
export const createCompany = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.COMPANIES_MANAGE);
  if (!ctx.isPlatformAdmin) {
    throw new HttpsError("permission-denied", "Platform administrator required.");
  }

  const name = String(request.data?.name || "").trim();
  if (!name || name.length > 200) {
    throw new HttpsError("invalid-argument", "Valid company name required.");
  }

  const settings = await getPortalSettings();
  const ref = db.collection("companies").doc();
  const iso = nowIso();
  const company = {
    id: ref.id,
    name,
    status: "active" as CompanyStatus,
    createdAt: iso,
    createdBy: ctx.uid,
    updatedAt: iso,
    branding: {
      primaryColor: null,
      logoUrl: null,
      displayName: null,
    },
    displayEmailName: name,
    replyToEmail: null as string | null,
    smtpGmailAddress: null as string | null,
    emailConfigured: false,
    emailConnectionStatus: "not_configured" as const,
    emailLastTestAt: null as string | null,
    emailLastError: null as string | null,
    emailBranding: {},
    activeNdaId: settings.activeNdaId || "",
    activeTermsId: settings.activeTermsId || "",
    activePrivacyId: settings.activePrivacyId || "",
    activeVideoId: settings.activeVideoId || "",
    managerIds: [] as string[],
    representativeIds: [] as string[],
    defaultInviteTtlHours: settings.defaultInviteTtlHours || 168,
  };

  await ref.set({
    ...company,
    createdAtServer: FieldValue.serverTimestamp(),
    updatedAtServer: FieldValue.serverTimestamp(),
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.REPRESENTATIVE_ACTION,
    actorUid: ctx.uid,
    actorType: "administrator",
    payload: { action: "company_created", companyId: ref.id, name },
  });

  return { company };
});

/** Update company name, branding, status, or active content pointers. */
export const updateCompany = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.COMPANIES_MANAGE);
  if (!ctx.isPlatformAdmin) {
    throw new HttpsError("permission-denied", "Platform administrator required.");
  }

  const companyId = String(request.data?.companyId || "").trim();
  if (!companyId) throw new HttpsError("invalid-argument", "companyId required.");

  const ref = db.collection("companies").doc(companyId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Company not found.");

  const patch: Record<string, unknown> = {
    updatedAt: nowIso(),
    updatedAtServer: FieldValue.serverTimestamp(),
  };

  if (typeof request.data?.name === "string") {
    const name = request.data.name.trim();
    if (!name || name.length > 200) {
      throw new HttpsError("invalid-argument", "Valid company name required.");
    }
    patch.name = name;
  }

  if (typeof request.data?.status === "string") {
    const status = request.data.status as CompanyStatus;
    if (status !== "active" && status !== "inactive") {
      throw new HttpsError("invalid-argument", "status must be active|inactive.");
    }
    patch.status = status;
  }

  if (request.data?.branding && typeof request.data.branding === "object") {
    const branding = request.data.branding as Record<string, unknown>;
    patch.branding = {
      ...(snap.data()?.branding || {}),
      ...branding,
    };
  }

  if (typeof request.data?.displayEmailName === "string") {
    const displayEmailName = request.data.displayEmailName.trim();
    patch.displayEmailName = displayEmailName || snap.data()?.name || null;
  }

  if (request.data?.replyToEmail !== undefined) {
    const reply = String(request.data.replyToEmail || "").trim();
    patch.replyToEmail = reply || null;
  }

  if (request.data?.emailBranding && typeof request.data.emailBranding === "object") {
    patch.emailBranding = {
      ...(snap.data()?.emailBranding || {}),
      ...(request.data.emailBranding as Record<string, unknown>),
    };
  }

  for (const field of [
    "activeNdaId",
    "activeTermsId",
    "activePrivacyId",
    "activeVideoId",
    "defaultInviteTtlHours",
  ] as const) {
    if (request.data?.[field] !== undefined) {
      patch[field] = request.data[field];
    }
  }

  await ref.update(patch);

  if (patch.status === "inactive") {
    // No cascading deletes — invitations already issued remain valid.
  }

  await writeAuditEvent({
    type: AUDIT_EVENT.REPRESENTATIVE_ACTION,
    actorUid: ctx.uid,
    actorType: "administrator",
    payload: { action: "company_updated", companyId, patch: Object.keys(patch) },
  });

  const after = await ref.get();
  return { company: { id: after.id, ...after.data() } };
});

/** Get a single company with manager/representative details. */
export const getCompanyDetails = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  const companyId = resolveActingCompanyId(
    ctx,
    typeof request.data?.companyId === "string" ? request.data.companyId : null,
  );

  if (
    !ctx.isPlatformAdmin &&
    !ctx.permissions.includes(PERMISSIONS.COMPANIES_MANAGE) &&
    ctx.companyId !== companyId
  ) {
    throw new HttpsError("permission-denied", "Cross-company access denied.");
  }

  const snap = await db.collection("companies").doc(companyId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Company not found.");
  const companyData = snap.data() as Record<string, unknown>;
  const company = { id: snap.id, ...companyData };

  const managerIds = (companyData.managerIds as string[]) || [];
  const representativeIds = (companyData.representativeIds as string[]) || [];
  const staffIds = Array.from(new Set([...managerIds, ...representativeIds]));
  const staff: Array<Record<string, unknown>> = [];
  for (const uid of staffIds) {
    const u = await db.collection("users").doc(uid).get();
    if (u.exists) {
      const d = u.data()!;
      staff.push({
        uid: u.id,
        email: d.email,
        displayName: d.displayName,
        primaryRole: d.primaryRole,
        status: d.status,
        companyId: d.companyId,
      });
    }
  }

  return {
    company,
    managers: staff.filter((s) => managerIds.includes(String(s.uid))),
    representatives: staff.filter((s) =>
      representativeIds.includes(String(s.uid)),
    ),
  };
});
