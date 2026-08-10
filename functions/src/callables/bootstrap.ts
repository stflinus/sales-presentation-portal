import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  APP_VERSION,
  CONTENT_STATUS,
  LEGAL_DOC_TYPE,
  ROLE_IDS,
  ROLE_PERMISSIONS,
} from "../shared";
import { requireAuth, syncUserClaims } from "../lib/authz";
import { sha256Hex } from "../lib/crypto";
import { auth, db } from "../lib/firebase";

/**
 * One-time / idempotent bootstrap for roles, placeholder legal docs, settings, and admin user.
 * Requires the caller to already exist in Firebase Auth.
 * First caller becomes administrator if no admin exists yet; later calls require admin claim
 * OR BOOTSTRAP_ALLOW_EMAIL match.
 */
export const bootstrapAdmin = onCall(async (request) => {
  const uid = requireAuth(request);
  const email = String(request.auth?.token?.email || "").toLowerCase();
  const displayName = String(
    request.data?.displayName || request.auth?.token?.name || email || "Administrator",
  );

  const usersCount = await db.collection("users").limit(1).get();
  const settingsSnap = await db.collection("settings").doc("portal").get();
  const isFirstBootstrap = usersCount.empty && !settingsSnap.exists;

  if (!isFirstBootstrap) {
    const caller = await db.collection("users").doc(uid).get();
    const roles = (caller.data()?.roleIds as string[]) || [];
    if (!roles.includes(ROLE_IDS.ADMINISTRATOR)) {
      throw new HttpsError(
        "permission-denied",
        "Bootstrap already completed. An administrator must manage content.",
      );
    }
  }

  // Seed roles
  for (const [roleId, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    await db.collection("roles").doc(roleId).set(
      {
        id: roleId,
        name: roleId,
        permissions: [...permissions],
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  const placeholder = (type: string, title: string, body: string) => {
    const contentSha256 = sha256Hex(body);
    return { type, title, body, contentSha256 };
  };

  const ndaBody =
    "[PLACEHOLDER — Replace via admin before client use]\n\n" +
    "This Non-Disclosure Agreement placeholder must be replaced with counsel-approved language.";
  const termsBody =
    "[PLACEHOLDER — Replace via admin before client use]\n\n" +
    "These Terms & Conditions are a placeholder and must be replaced before production use.";
  const privacyBody =
    "[PLACEHOLDER — Replace via admin before client use]\n\n" +
    "This Privacy Policy is a placeholder and must be replaced before production use.";

  // Prefer production legal docs. Do not create new placeholder legal content when
  // an active published document already exists for the type.
  async function ensurePlaceholderLegal(
    type: string,
    versionLabel: string,
    title: string,
    body: string,
  ): Promise<string | null> {
    const activePublished = await db
      .collection("legalDocuments")
      .where("type", "==", type)
      .where("status", "==", CONTENT_STATUS.ACTIVE)
      .limit(5)
      .get();
    const hasPublished = activePublished.docs.some(
      (d) => d.data()?.isPlaceholder !== true,
    );
    if (hasPublished) return null;

    const existing = await db
      .collection("legalDocuments")
      .where("type", "==", type)
      .where("status", "==", CONTENT_STATUS.PLACEHOLDER)
      .limit(1)
      .get();
    if (!existing.empty) return existing.docs[0]!.id;

    const ref = db.collection("legalDocuments").doc();
    const meta = placeholder(type, title, body);
    await ref.set({
      id: ref.id,
      type,
      versionLabel,
      title: meta.title,
      body: meta.body,
      contentSha256: meta.contentSha256,
      status: CONTENT_STATUS.PLACEHOLDER,
      isPlaceholder: true,
      createdAt: new Date().toISOString(),
      createdBy: uid,
      createdAtServer: FieldValue.serverTimestamp(),
    });
    return ref.id;
  }

  await ensurePlaceholderLegal(
    LEGAL_DOC_TYPE.NDA,
    "0.1-placeholder",
    "Non-Disclosure Agreement",
    ndaBody,
  );
  await ensurePlaceholderLegal(
    LEGAL_DOC_TYPE.TERMS,
    "0.1-placeholder",
    "Terms & Conditions",
    termsBody,
  );
  await ensurePlaceholderLegal(
    LEGAL_DOC_TYPE.PRIVACY,
    "0.1-placeholder",
    "Privacy Policy",
    privacyBody,
  );

  // Do not create placeholder videos. Use Video Library to upload and activate.
  const existingSettings = settingsSnap.exists ? settingsSnap.data()! : {};
  await db.collection("settings").doc("portal").set(
    {
      activeNdaId: existingSettings.activeNdaId || "",
      activeTermsId: existingSettings.activeTermsId || "",
      activePrivacyId: existingSettings.activePrivacyId || "",
      activeVideoId: existingSettings.activeVideoId || "",
      defaultInviteTtlHours: 168,
      companyName:
        request.data?.companyName ||
        existingSettings.companyName ||
        "Sales Presentation Portal",
      supportEmail: email || existingSettings.supportEmail || "",
      appVersion: APP_VERSION,
      contentReady: false,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await db.collection("users").doc(uid).set(
    {
      uid,
      email,
      displayName,
      roleIds: [ROLE_IDS.ADMINISTRATOR],
      primaryRole: ROLE_IDS.ADMINISTRATOR,
      permissions: [...ROLE_PERMISSIONS.administrator],
      companyId: null,
      status: "active",
      createdAt: new Date().toISOString(),
      createdBy: uid,
      updatedAt: new Date().toISOString(),
      updatedAtServer: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await syncUserClaims(uid);
  // Force token refresh on client after this call.
  await auth.revokeRefreshTokens(uid);

  return {
    ok: true,
    firstBootstrap: isFirstBootstrap,
    invitesBlockedUntilPublishedContent: true,
    message:
      "Bootstrap complete. Publish legal docs and upload/activate a production video in Video Library before creating client invitations.",
  };
});

/**
 * Promote/create a representative profile (admin only).
 * @deprecated Prefer createStaffUser, which supports managers and Auth user creation.
 */
export const upsertRepresentative = onCall(async (request) => {
  const uid0 = requireAuth(request);
  const permissions = (request.auth?.token?.permissions as string[]) || [];
  if (!permissions.includes("users:manage")) {
    throw new HttpsError("permission-denied", "Administrator required.");
  }

  const targetUid = String(request.data?.uid || "");
  const targetEmail = String(request.data?.email || "").toLowerCase();
  const displayName = String(request.data?.displayName || targetEmail);
  const companyId = String(request.data?.companyId || "").trim();
  if (!targetUid && !targetEmail) {
    throw new HttpsError("invalid-argument", "uid or email required.");
  }
  if (!companyId) {
    throw new HttpsError("invalid-argument", "companyId required.");
  }
  const companySnap = await db.collection("companies").doc(companyId).get();
  if (!companySnap.exists) {
    throw new HttpsError("not-found", "Company not found.");
  }

  let uid = targetUid;
  if (!uid) {
    const user = await auth.getUserByEmail(targetEmail);
    uid = user.uid;
  }

  const existing = await db.collection("users").doc(uid).get();
  await db.collection("users").doc(uid).set(
    {
      uid,
      email: targetEmail || (await auth.getUser(uid)).email,
      displayName,
      roleIds: [ROLE_IDS.REPRESENTATIVE],
      primaryRole: ROLE_IDS.REPRESENTATIVE,
      permissions: [...ROLE_PERMISSIONS.representative],
      companyId,
      status: "active",
      updatedAt: new Date().toISOString(),
      updatedAtServer: FieldValue.serverTimestamp(),
      createdAt: existing.exists
        ? existing.data()?.createdAt || new Date().toISOString()
        : new Date().toISOString(),
      createdBy: existing.exists ? existing.data()?.createdBy || uid0 : uid0,
    },
    { merge: true },
  );
  await db.collection("companies").doc(companyId).set(
    {
      representativeIds: FieldValue.arrayUnion(uid),
      updatedAt: new Date().toISOString(),
      updatedAtServer: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await syncUserClaims(uid);
  return { ok: true, uid, companyId };
});
