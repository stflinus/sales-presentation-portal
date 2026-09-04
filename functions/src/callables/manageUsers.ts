import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  AUDIT_EVENT,
  PERMISSIONS,
  ROLE_IDS,
  accessPolicySummary,
  isPlatformAdminRole,
  type Permission,
  type RoleId,
} from "../shared";
import {
  assertHasPermission,
  assertPresentationPoliciesManage,
  canManagePresentationPolicies,
  loadStaffContext,
  permissionsForRole,
  resolveActingCompanyId,
  syncUserClaims,
  type StaffContext,
} from "../lib/authz";
import { writeAuditEvent } from "../lib/audit";
import { auth, db } from "../lib/firebase";
import {
  assertNotSelfDestructiveDelete,
  canActorModifyTargetRole,
  formatUserDeletionBlockMessage,
  generateUserErrorCode,
  inviteBlocksUserDeletion,
  isValidStaffEmail,
  normalizeStaffEmail,
  sessionBlocksUserDeletion,
  staffRoleAssignableByAdmin,
  wouldRemoveLastPlatformOwner,
} from "../lib/userLifecycle.pure";

function nowIso() {
  return new Date().toISOString();
}

function userError(
  code:
    | "invalid-argument"
    | "permission-denied"
    | "not-found"
    | "failed-precondition"
    | "already-exists"
    | "internal",
  message: string,
  details?: Record<string, unknown>,
): HttpsError {
  const errorId = generateUserErrorCode();
  return new HttpsError(code, `${message} [${errorId}]`, {
    errorId,
    ...details,
  });
}

async function listActivePlatformOwnerAdminUids(): Promise<string[]> {
  const snap = await db.collection("users").get();
  return snap.docs
    .filter((d) => {
      const data = d.data();
      const role = data.primaryRole || data.roleIds?.[0];
      const status = data.status || "active";
      return isPlatformAdminRole(role) && status === "active";
    })
    .map((d) => d.id);
}

function assertCanModifyExistingStaff(
  ctx: StaffContext,
  targetCompanyId: string | null,
  targetRole: RoleId | string | null | undefined,
) {
  if (!canActorModifyTargetRole({
    actorIsPlatformAdmin: ctx.isPlatformAdmin,
    targetRole,
  })) {
    throw userError(
      "permission-denied",
      "Insufficient permission to modify this user (owner/admin target).",
      { failure: "insufficient_permission" },
    );
  }

  if (ctx.permissions.includes(PERMISSIONS.USERS_MANAGE) && ctx.isPlatformAdmin) {
    return;
  }

  if (
    ctx.permissions.includes(PERMISSIONS.USERS_EDIT) ||
    ctx.permissions.includes(PERMISSIONS.USERS_MANAGE_COMPANY) ||
    ctx.permissions.includes(PERMISSIONS.USERS_DEACTIVATE)
  ) {
    if (isPlatformAdminRole(targetRole)) {
      throw userError(
        "permission-denied",
        "Cannot modify Platform Administrators.",
        { failure: "insufficient_permission" },
      );
    }
    if (!ctx.companyId || !targetCompanyId || ctx.companyId !== targetCompanyId) {
      throw userError(
        "permission-denied",
        "Cross-company access denied.",
        { failure: "insufficient_permission" },
      );
    }
    return;
  }

  throw userError(
    "permission-denied",
    "Missing users edit permission.",
    { failure: "insufficient_permission" },
  );
}

async function countActiveDependenciesForUser(uid: string): Promise<{
  activeInviteCount: number;
  activeSessionCount: number;
}> {
  const [inviteSnap, sessionSnap] = await Promise.all([
    db.collection("invites").where("representativeId", "==", uid).get(),
    db
      .collection("presentationSessions")
      .where("representativeId", "==", uid)
      .get(),
  ]);

  const activeInviteCount = inviteSnap.docs.filter((d) =>
    inviteBlocksUserDeletion(d.data()?.status),
  ).length;
  const activeSessionCount = sessionSnap.docs.filter((d) =>
    sessionBlocksUserDeletion(d.data()?.status),
  ).length;

  return { activeInviteCount, activeSessionCount };
}

function randomTempPassword(): string {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@$%";
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

async function syncCompanyMembership(input: {
  companyId: string;
  uid: string;
  role: RoleId;
  remove?: boolean;
}) {
  const ref = db.collection("companies").doc(input.companyId);
  const field =
    input.role === ROLE_IDS.MANAGER ? "managerIds" : "representativeIds";
  if (input.remove) {
    await ref.set(
      {
        [field]: FieldValue.arrayRemove(input.uid),
        updatedAt: nowIso(),
        updatedAtServer: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return;
  }
  await ref.set(
    {
      [field]: FieldValue.arrayUnion(input.uid),
      updatedAt: nowIso(),
      updatedAtServer: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

function assertCanManageUsers(
  ctx: Awaited<ReturnType<typeof loadStaffContext>>,
  targetCompanyId: string | null,
  targetRole: RoleId,
) {
  if (isPlatformAdminRole(targetRole)) {
    throw new HttpsError(
      "permission-denied",
      "Platform Administrators cannot be created via this endpoint.",
    );
  }

  if (ctx.permissions.includes(PERMISSIONS.USERS_MANAGE) && ctx.isPlatformAdmin) {
    return;
  }

  if (ctx.permissions.includes(PERMISSIONS.USERS_MANAGE_COMPANY)) {
    if (targetRole !== ROLE_IDS.REPRESENTATIVE) {
      throw new HttpsError(
        "permission-denied",
        "Company Managers may only create Representatives.",
      );
    }
    if (!ctx.companyId || ctx.companyId !== targetCompanyId) {
      throw new HttpsError("permission-denied", "Cross-company access denied.");
    }
    return;
  }

  throw new HttpsError("permission-denied", "Missing users manage permission.");
}

/** List staff users (platform: all; manager: own company). */
export const listStaffUsers = onCall(async (request) => {
  const ctx = await loadStaffContext(request);

  let snap;
  if (ctx.isPlatformAdmin && ctx.permissions.includes(PERMISSIONS.USERS_MANAGE)) {
    snap = await db.collection("users").get();
  } else if (ctx.permissions.includes(PERMISSIONS.USERS_MANAGE_COMPANY)) {
    if (!ctx.companyId) {
      throw new HttpsError("failed-precondition", "No company assignment.");
    }
    snap = await db
      .collection("users")
      .where("companyId", "==", ctx.companyId)
      .get();
  } else {
    throw new HttpsError("permission-denied", "Missing users manage permission.");
  }

  const users = snap.docs
    .map((d) => {
      const data = d.data();
      const ps = data.presentationSettings as Record<string, unknown> | null | undefined;
      return {
        uid: d.id,
        email: data.email,
        displayName: data.displayName,
        phone: data.phone ?? null,
        title: data.title ?? null,
        primaryRole: data.primaryRole || data.roleIds?.[0] || null,
        roleIds: data.roleIds || [],
        permissions: data.permissions || [],
        companyId: data.companyId ?? null,
        status: data.status || "active",
        createdAt: data.createdAt || null,
        createdBy: data.createdBy || null,
        updatedAt: data.updatedAt || null,
        presentationSettings: ps || null,
      };
    })
    .filter((u) => String(u.primaryRole || "") !== ROLE_IDS.CLIENT)
    .sort((a, b) => String(a.email || "").localeCompare(String(b.email || "")));

  const canEnrichPresentation = canManagePresentationPolicies(ctx);

  const videoIds = [
    ...new Set(
      users
        .map((u) => String(u.presentationSettings?.activeVideoId || "").trim())
        .filter(Boolean),
    ),
  ];
  const companyIds = [
    ...new Set(
      users
        .map((u) => String(u.companyId || "").trim())
        .filter(Boolean),
    ),
  ];
  const videoTitles = new Map<string, string>();
  const companyDefaultVideos = new Map<string, { id: string; title: string }>();

  if (canEnrichPresentation) {
    await Promise.all([
      ...videoIds.map(async (id) => {
        const snap = await db.collection("videos").doc(id).get();
        if (snap.exists) {
          videoTitles.set(id, String(snap.data()?.title || id));
        }
      }),
      ...companyIds.map(async (companyId) => {
        const companySnap = await db.collection("companies").doc(companyId).get();
        const activeVideoId = String(companySnap.data()?.activeVideoId || "").trim();
        if (!activeVideoId) return;
        const vSnap = await db.collection("videos").doc(activeVideoId).get();
        companyDefaultVideos.set(companyId, {
          id: activeVideoId,
          title: vSnap.exists
            ? String(vSnap.data()?.title || activeVideoId)
            : activeVideoId,
        });
      }),
    ]);
  }

  const enriched = users.map((u) => {
    if (!canEnrichPresentation) {
      return u;
    }
    const ps = u.presentationSettings as Record<string, unknown> | null;
    const activeVideoId = String(ps?.activeVideoId || "").trim();
    const companyDefault = u.companyId
      ? companyDefaultVideos.get(String(u.companyId))
      : null;
    const videoTitle = activeVideoId
      ? videoTitles.get(activeVideoId) || activeVideoId
      : companyDefault?.title || "Company default";
    const accessLabel = accessPolicySummary(
      ps?.accessPolicy as string | null | undefined,
      ps?.accessDurationDays as number | null | undefined,
    );
    return {
      ...u,
      presentationSummary: { videoTitle, accessLabel },
    };
  });

  return { users: enriched };
});

/** Platform owner/admin: read presentation settings + selectable videos for a staff user. */
export const getStaffPresentationSettings = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertPresentationPoliciesManage(ctx);

  const targetUid = String(request.data?.uid || "").trim();
  if (!targetUid) throw new HttpsError("invalid-argument", "uid required.");

  const snap = await db.collection("users").doc(targetUid).get();
  if (!snap.exists) throw new HttpsError("not-found", "User not found.");
  const data = snap.data()!;
  if (isPlatformAdminRole(data.primaryRole)) {
    throw new HttpsError("failed-precondition", "Platform administrators have no presentation settings.");
  }
  const companyId = String(data.companyId || "");
  if (!companyId) throw new HttpsError("failed-precondition", "User has no company assignment.");

  const { listActiveVideosForCompany } = await import("../lib/presentationPolicy");
  const videos = await listActiveVideosForCompany(companyId);
  const companySnap = await db.collection("companies").doc(companyId).get();
  const companyActiveVideoId = companySnap.data()?.activeVideoId || null;

  return {
    uid: targetUid,
    displayName: data.displayName,
    companyId,
    companyActiveVideoId,
    presentationSettings: data.presentationSettings || null,
    videos,
  };
});

/** Platform owner/admin: update per-user presentation video & access policy. */
export const updateStaffPresentationSettings = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertPresentationPoliciesManage(ctx);

  const targetUid = String(request.data?.uid || "").trim();
  if (!targetUid) throw new HttpsError("invalid-argument", "uid required.");

  const snap = await db.collection("users").doc(targetUid).get();
  if (!snap.exists) throw new HttpsError("not-found", "User not found.");
  const data = snap.data()!;
  if (isPlatformAdminRole(data.primaryRole)) {
    throw new HttpsError("failed-precondition", "Cannot configure platform administrators.");
  }
  const companyId = String(data.companyId || "");
  if (!companyId) throw new HttpsError("failed-precondition", "User has no company assignment.");

  const previousSettings =
    (data.presentationSettings as Record<string, unknown> | null | undefined) ||
    null;

  const { validateAdminPresentationSettings } = await import("../lib/presentationPolicy");
  const presentationSettings = await validateAdminPresentationSettings({
    companyId,
    activeVideoId: request.data?.activeVideoId,
    accessPolicy: request.data?.accessPolicy,
    accessDurationDays: request.data?.accessDurationDays,
  });

  await db.collection("users").doc(targetUid).update({
    presentationSettings,
    updatedAt: nowIso(),
    updatedAtServer: FieldValue.serverTimestamp(),
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.USER_ACCESS_POLICY_CHANGED,
    actorUid: ctx.uid,
    actorType: "administrator",
    payload: {
      targetUid,
      before: previousSettings,
      after: presentationSettings,
      fieldsChanged: ["accessPolicy", "accessDurationDays", "activeVideoId"],
    },
  });
  await writeAuditEvent({
    type: AUDIT_EVENT.USER_PRESENTATION_ASSIGNMENT_CHANGED,
    actorUid: ctx.uid,
    actorType: "administrator",
    payload: {
      targetUid,
      beforeVideoId: previousSettings?.activeVideoId ?? null,
      afterVideoId: presentationSettings.activeVideoId,
    },
  });
  await writeAuditEvent({
    type: AUDIT_EVENT.REPRESENTATIVE_ACTION,
    actorUid: ctx.uid,
    actorType: "administrator",
    payload: {
      action: "staff_presentation_settings_updated",
      targetUid,
      presentationSettings,
    },
  });

  return { ok: true, uid: targetUid, presentationSettings };
});

/**
 * Create a Company Manager or Representative.
 * Creates Firebase Auth user with a temporary password when email is new.
 */
export const createStaffUser = onCall(async (request) => {
  const ctx = await loadStaffContext(request);

  const email = String(request.data?.email || "").trim().toLowerCase();
  const displayName = String(request.data?.displayName || "").trim() || email;
  const role = String(request.data?.role || "").trim() as RoleId;
  const extraPermissions = Array.isArray(request.data?.permissions)
    ? (request.data.permissions as Permission[])
    : [];

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError("invalid-argument", "Valid email required.");
  }
  if (role !== ROLE_IDS.MANAGER && role !== ROLE_IDS.REPRESENTATIVE) {
    throw new HttpsError(
      "invalid-argument",
      "role must be manager or representative.",
    );
  }

  let companyId: string;
  if (ctx.isPlatformAdmin) {
    companyId = resolveActingCompanyId(
      ctx,
      typeof request.data?.companyId === "string" ? request.data.companyId : null,
    );
  } else {
    companyId = resolveActingCompanyId(ctx, null);
  }

  assertCanManageUsers(ctx, companyId, role);

  const companySnap = await db.collection("companies").doc(companyId).get();
  if (!companySnap.exists) throw new HttpsError("not-found", "Company not found.");
  if (companySnap.data()?.status !== "active") {
    throw new HttpsError("failed-precondition", "Company is inactive.");
  }

  let uid: string;
  let temporaryPassword: string | null = null;
  let createdAuthUser = false;

  try {
    const existing = await auth.getUserByEmail(email);
    uid = existing.uid;
  } catch {
    temporaryPassword = randomTempPassword();
    const created = await auth.createUser({
      email,
      password: temporaryPassword,
      displayName,
      emailVerified: false,
      disabled: false,
    });
    uid = created.uid;
    createdAuthUser = true;
  }

  const existingProfile = await db.collection("users").doc(uid).get();
  if (existingProfile.exists) {
    const existingRole = existingProfile.data()?.primaryRole;
    if (isPlatformAdminRole(existingRole)) {
      throw new HttpsError(
        "failed-precondition",
        "Cannot reassign a Platform Administrator via this endpoint.",
      );
    }
  }

  const basePerms = permissionsForRole(role);
  const permissionSet = new Set<Permission>([...basePerms]);
  // Optional grants for managers (videos/legal) when platform admin assigns them.
  for (const p of extraPermissions) {
    if (
      role === ROLE_IDS.MANAGER &&
      (p === PERMISSIONS.VIDEOS_MANAGE || p === PERMISSIONS.LEGAL_MANAGE)
    ) {
      permissionSet.add(p);
    }
  }
  const permissions = Array.from(permissionSet);
  const iso = nowIso();

  await db.collection("users").doc(uid).set(
    {
      uid,
      email,
      displayName,
      roleIds: [role],
      primaryRole: role,
      permissions,
      companyId,
      status: "active",
      createdAt: existingProfile.exists
        ? existingProfile.data()?.createdAt || iso
        : iso,
      createdBy: existingProfile.exists
        ? existingProfile.data()?.createdBy || ctx.uid
        : ctx.uid,
      updatedAt: iso,
      updatedAtServer: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await syncCompanyMembership({ companyId, uid, role });
  await syncUserClaims(uid);

  await writeAuditEvent({
    type: AUDIT_EVENT.REPRESENTATIVE_ACTION,
    actorUid: ctx.uid,
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    payload: {
      action: "staff_user_created",
      targetUid: uid,
      email,
      role,
      companyId,
      createdAuthUser,
    },
  });

  return {
    ok: true,
    uid,
    email,
    role,
    companyId,
    permissions,
    temporaryPassword,
    createdAuthUser,
    message: temporaryPassword
      ? "User created. Share the temporary password securely; user should change it after first sign-in."
      : "Existing Auth user linked and staff profile updated.",
  };
});

/** Activate or deactivate a staff user. */
export const setStaffUserStatus = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.USERS_DEACTIVATE);

  const targetUid = String(request.data?.uid || "").trim();
  const status = String(request.data?.status || "").trim();
  if (!targetUid) throw userError("invalid-argument", "uid required.");
  if (status !== "active" && status !== "inactive") {
    throw userError("invalid-argument", "status must be active|inactive.");
  }

  if (targetUid === ctx.uid && status === "inactive") {
    throw userError(
      "failed-precondition",
      "You cannot deactivate your own signed-in account.",
      { failure: "self_protection" },
    );
  }

  const snap = await db.collection("users").doc(targetUid).get();
  if (!snap.exists) throw userError("not-found", "User not found.");
  const data = snap.data()!;
  const targetRole = (data.primaryRole || data.roleIds?.[0]) as RoleId;
  const previousStatus = String(data.status || "active");

  assertCanModifyExistingStaff(ctx, (data.companyId as string) || null, targetRole);

  if (status === "inactive" && isPlatformAdminRole(targetRole)) {
    const owners = await listActivePlatformOwnerAdminUids();
    const guard = wouldRemoveLastPlatformOwner({
      targetUid,
      targetRole,
      targetStatus: previousStatus,
      action: "deactivate",
      activeOwnerAdminUids: owners,
    });
    if (!guard.ok) {
      throw userError("failed-precondition", guard.reason, {
        failure: "last_owner_protection",
      });
    }
  }

  try {
    await db.collection("users").doc(targetUid).update({
      status,
      updatedAt: nowIso(),
      updatedAtServer: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    throw userError(
      "internal",
      `Firestore update failed: ${err instanceof Error ? err.message : "unknown"}`,
      { failure: "firestore_update_failed" },
    );
  }

  try {
    if (status === "inactive") {
      await auth.updateUser(targetUid, { disabled: true });
      if (data.companyId) {
        await syncCompanyMembership({
          companyId: String(data.companyId),
          uid: targetUid,
          role:
            targetRole === ROLE_IDS.MANAGER
              ? ROLE_IDS.MANAGER
              : ROLE_IDS.REPRESENTATIVE,
          remove: true,
        });
      }
    } else {
      await auth.updateUser(targetUid, { disabled: false });
      if (data.companyId) {
        await syncCompanyMembership({
          companyId: String(data.companyId),
          uid: targetUid,
          role:
            targetRole === ROLE_IDS.MANAGER
              ? ROLE_IDS.MANAGER
              : ROLE_IDS.REPRESENTATIVE,
        });
      }
      await syncUserClaims(targetUid);
    }
  } catch (err) {
    // Compensate Firestore if Auth fails
    try {
      await db.collection("users").doc(targetUid).update({
        status: previousStatus,
        updatedAt: nowIso(),
        updatedAtServer: FieldValue.serverTimestamp(),
      });
    } catch {
      /* logged via error below */
    }
    throw userError(
      "internal",
      `Firebase Auth update failed: ${err instanceof Error ? err.message : "unknown"}`,
      { failure: "firebase_auth_update_failed" },
    );
  }

  await writeAuditEvent({
    type:
      status === "inactive"
        ? AUDIT_EVENT.USER_DEACTIVATED
        : AUDIT_EVENT.USER_REACTIVATED,
    actorUid: ctx.uid,
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    payload: {
      targetUid,
      before: previousStatus,
      after: status,
      companyId: data.companyId || null,
      displayNameSnapshot: data.displayName || null,
      roleSnapshot: targetRole,
    },
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.REPRESENTATIVE_ACTION,
    actorUid: ctx.uid,
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    payload: {
      action: "staff_user_status",
      targetUid,
      status,
      companyId: data.companyId || null,
    },
  });

  return { ok: true, uid: targetUid, status };
});

/**
 * Reset temporary password via Admin SDK (safe supported process).
 * Returns the new temporary password once to the authorized caller.
 */
export const resetStaffTemporaryPassword = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.USERS_MANAGE);
  if (!ctx.isPlatformAdmin) {
    throw new HttpsError("permission-denied", "Platform administrator required.");
  }

  const targetUid = String(request.data?.uid || "").trim();
  if (!targetUid) throw new HttpsError("invalid-argument", "uid required.");

  const snap = await db.collection("users").doc(targetUid).get();
  if (!snap.exists) throw new HttpsError("not-found", "User not found.");
  const data = snap.data()!;
  if (isPlatformAdminRole(data.primaryRole)) {
    throw new HttpsError(
      "failed-precondition",
      "Reset Platform Administrator password via Firebase Console or account recovery.",
    );
  }

  const temporaryPassword = randomTempPassword();
  await auth.updateUser(targetUid, {
    password: temporaryPassword,
    disabled: data.status === "inactive" || data.status === "disabled",
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.REPRESENTATIVE_ACTION,
    actorUid: ctx.uid,
    actorType: "administrator",
    payload: {
      action: "staff_temp_password_reset",
      targetUid,
      email: data.email,
    },
  });

  return {
    ok: true,
    uid: targetUid,
    temporaryPassword,
    message:
      "Temporary password set. Share it securely; do not store it in Firestore.",
  };
});

/** Assign or reassign a staff user to a company (platform admin). */
export const assignStaffCompany = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.USERS_MANAGE);
  if (!ctx.isPlatformAdmin) {
    throw new HttpsError("permission-denied", "Platform administrator required.");
  }

  const targetUid = String(request.data?.uid || "").trim();
  const companyId = String(request.data?.companyId || "").trim();
  if (!targetUid || !companyId) {
    throw new HttpsError("invalid-argument", "uid and companyId required.");
  }

  const userSnap = await db.collection("users").doc(targetUid).get();
  if (!userSnap.exists) throw new HttpsError("not-found", "User not found.");
  const data = userSnap.data()!;
  const role = (data.primaryRole || data.roleIds?.[0] || ROLE_IDS.REPRESENTATIVE) as RoleId;
  if (isPlatformAdminRole(role)) {
    throw new HttpsError(
      "failed-precondition",
      "Platform Administrators are not company-scoped.",
    );
  }

  const companySnap = await db.collection("companies").doc(companyId).get();
  if (!companySnap.exists) throw new HttpsError("not-found", "Company not found.");

  const previousCompanyId = (data.companyId as string | null) || null;
  if (previousCompanyId && previousCompanyId !== companyId) {
    await syncCompanyMembership({
      companyId: previousCompanyId,
      uid: targetUid,
      role: role === ROLE_IDS.MANAGER ? ROLE_IDS.MANAGER : ROLE_IDS.REPRESENTATIVE,
      remove: true,
    });
  }

  await db.collection("users").doc(targetUid).update({
    companyId,
    updatedAt: nowIso(),
    updatedAtServer: FieldValue.serverTimestamp(),
  });
  await syncCompanyMembership({
    companyId,
    uid: targetUid,
    role: role === ROLE_IDS.MANAGER ? ROLE_IDS.MANAGER : ROLE_IDS.REPRESENTATIVE,
  });
  await syncUserClaims(targetUid);

  await writeAuditEvent({
    type: AUDIT_EVENT.REPRESENTATIVE_ACTION,
    actorUid: ctx.uid,
    actorType: "administrator",
    payload: {
      action: "staff_company_assigned",
      targetUid,
      companyId,
      previousCompanyId,
    },
  });

  return { ok: true, uid: targetUid, companyId };
});

/**
 * Edit staff profile: name, phone, email (Auth+Firestore), role, status,
 * and optionally presentation settings — with RBAC + consistency guards.
 */
export const updateStaffUser = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.USERS_EDIT);

  const targetUid = String(request.data?.uid || "").trim();
  if (!targetUid) throw userError("invalid-argument", "uid required.");

  const snap = await db.collection("users").doc(targetUid).get();
  if (!snap.exists) throw userError("not-found", "User not found.");
  const data = snap.data()!;
  const targetRole = (data.primaryRole || data.roleIds?.[0]) as RoleId;
  const previousStatus = String(data.status || "active");
  const previousEmail = normalizeStaffEmail(String(data.email || ""));

  assertCanModifyExistingStaff(ctx, (data.companyId as string) || null, targetRole);

  const fieldsChanged: string[] = [];
  const firestorePatch: Record<string, unknown> = {
    updatedAt: nowIso(),
    updatedAtServer: FieldValue.serverTimestamp(),
  };

  // --- displayName / phone / title ---
  if (request.data?.displayName !== undefined) {
    const displayName = String(request.data.displayName || "").trim();
    if (!displayName) {
      throw userError("invalid-argument", "Name is required.");
    }
    if (displayName !== String(data.displayName || "")) {
      firestorePatch.displayName = displayName;
      fieldsChanged.push("displayName");
    }
  }
  if (request.data?.phone !== undefined) {
    const phone = String(request.data.phone || "").trim() || null;
    if (phone !== (data.phone ?? null)) {
      firestorePatch.phone = phone;
      fieldsChanged.push("phone");
    }
  }
  if (request.data?.title !== undefined) {
    const title = String(request.data.title || "").trim() || null;
    if (title !== (data.title ?? null)) {
      firestorePatch.title = title;
      fieldsChanged.push("title");
    }
  }

  // --- email (platform admin only) ---
  let nextEmail: string | null = null;
  if (request.data?.email !== undefined) {
    if (!ctx.isPlatformAdmin || !ctx.permissions.includes(PERMISSIONS.USERS_MANAGE)) {
      throw userError(
        "permission-denied",
        "Only platform administrators can change user email addresses.",
        { failure: "insufficient_permission" },
      );
    }
    nextEmail = normalizeStaffEmail(String(request.data.email || ""));
    if (!isValidStaffEmail(nextEmail)) {
      throw userError("invalid-argument", "Valid email required.");
    }
    if (nextEmail !== previousEmail) {
      // Duplicate check: Auth
      try {
        const existingAuth = await auth.getUserByEmail(nextEmail);
        if (existingAuth.uid !== targetUid) {
          throw userError(
            "already-exists",
            "Another account already uses this email address.",
            { failure: "duplicate_email" },
          );
        }
      } catch (err) {
        if (err instanceof HttpsError) throw err;
        // getUserByEmail throws when not found — expected
      }
      // Duplicate check: Firestore profiles
      const emailDup = await db
        .collection("users")
        .where("email", "==", nextEmail)
        .limit(5)
        .get();
      const conflict = emailDup.docs.find((d) => d.id !== targetUid);
      if (conflict) {
        throw userError(
          "already-exists",
          "Another account already uses this email address.",
          { failure: "duplicate_email" },
        );
      }
      firestorePatch.email = nextEmail;
      fieldsChanged.push("email");
    } else {
      nextEmail = null;
    }
  }

  // --- role ---
  let nextRole: RoleId | null = null;
  if (request.data?.role !== undefined) {
    assertHasPermission(ctx, PERMISSIONS.USERS_CHANGE_ROLE);
    if (!ctx.isPlatformAdmin) {
      throw userError(
        "permission-denied",
        "Only platform administrators can change roles.",
        { failure: "insufficient_permission" },
      );
    }
    const role = String(request.data.role || "").trim() as RoleId;
    if (!staffRoleAssignableByAdmin(role) && !isPlatformAdminRole(role)) {
      throw userError(
        "invalid-argument",
        "role must be manager, representative, or a platform admin role.",
      );
    }
    // Do not allow promoting to owner via this form unless already platform admin editing peers carefully —
    // restrict assignable roles to manager/representative for safety (platform admins stay as-is).
    if (isPlatformAdminRole(targetRole)) {
      if (!isPlatformAdminRole(role)) {
        const owners = await listActivePlatformOwnerAdminUids();
        const guard = wouldRemoveLastPlatformOwner({
          targetUid,
          targetRole,
          targetStatus: previousStatus,
          action: "demote",
          activeOwnerAdminUids: owners,
        });
        if (!guard.ok) {
          throw userError("failed-precondition", guard.reason, {
            failure: "last_owner_protection",
          });
        }
        if (!staffRoleAssignableByAdmin(role)) {
          throw userError("invalid-argument", "Invalid demotion target role.");
        }
      }
    } else if (!staffRoleAssignableByAdmin(role)) {
      throw userError(
        "permission-denied",
        "Cannot promote users to platform owner/admin via this endpoint.",
        { failure: "insufficient_permission" },
      );
    }
    if (role !== targetRole) {
      nextRole = role;
      const permissions = permissionsForRole(role);
      firestorePatch.primaryRole = role;
      firestorePatch.roleIds = [role];
      firestorePatch.permissions = permissions;
      if (isPlatformAdminRole(role)) {
        firestorePatch.companyId = null;
      }
      fieldsChanged.push("role");
    }
  }

  // --- status ---
  let nextStatus: "active" | "inactive" | null = null;
  if (request.data?.status !== undefined) {
    assertHasPermission(ctx, PERMISSIONS.USERS_DEACTIVATE);
    const status = String(request.data.status || "").trim();
    if (status !== "active" && status !== "inactive") {
      throw userError("invalid-argument", "status must be active|inactive.");
    }
    if (targetUid === ctx.uid && status === "inactive") {
      throw userError(
        "failed-precondition",
        "You cannot deactivate your own signed-in account.",
        { failure: "self_protection" },
      );
    }
    if (status === "inactive" && isPlatformAdminRole(targetRole)) {
      const owners = await listActivePlatformOwnerAdminUids();
      const guard = wouldRemoveLastPlatformOwner({
        targetUid,
        targetRole,
        targetStatus: previousStatus,
        action: "deactivate",
        activeOwnerAdminUids: owners,
      });
      if (!guard.ok) {
        throw userError("failed-precondition", guard.reason, {
          failure: "last_owner_protection",
        });
      }
    }
    if (status !== previousStatus) {
      nextStatus = status as "active" | "inactive";
      firestorePatch.status = status;
      fieldsChanged.push("status");
    }
  }

  // --- presentation settings (optional, admin only) ---
  let presentationSettings: Record<string, unknown> | null = null;
  const previousPresentation =
    (data.presentationSettings as Record<string, unknown> | null | undefined) ||
    null;
  const wantsPresentationUpdate =
    request.data?.activeVideoId !== undefined ||
    request.data?.accessPolicy !== undefined ||
    request.data?.accessDurationDays !== undefined;

  if (wantsPresentationUpdate) {
    if (
      !ctx.permissions.includes(PERMISSIONS.USERS_CHANGE_PRESENTATION_POLICY) &&
      !ctx.permissions.includes(PERMISSIONS.PRESENTATION_POLICIES_MANAGE)
    ) {
      throw userError(
        "permission-denied",
        "Missing presentation policy permission.",
        { failure: "insufficient_permission" },
      );
    }
    if (isPlatformAdminRole(nextRole || targetRole)) {
      throw userError(
        "failed-precondition",
        "Cannot configure presentation settings for platform administrators.",
      );
    }
    const companyId = String(
      ((firestorePatch.companyId as string | null | undefined) ??
        data.companyId) ||
        "",
    );
    if (!companyId) {
      throw userError("failed-precondition", "User has no company assignment.");
    }
    const { validateAdminPresentationSettings } = await import(
      "../lib/presentationPolicy"
    );
    const validated = await validateAdminPresentationSettings({
      companyId,
      activeVideoId:
        request.data?.activeVideoId ?? previousPresentation?.activeVideoId,
      accessPolicy:
        request.data?.accessPolicy ?? previousPresentation?.accessPolicy,
      accessDurationDays:
        request.data?.accessDurationDays ??
        previousPresentation?.accessDurationDays,
    });
    presentationSettings = { ...validated };
    firestorePatch.presentationSettings = validated;
    fieldsChanged.push("presentationSettings");
  }

  if (fieldsChanged.length === 0) {
    return { ok: true, uid: targetUid, unchanged: true };
  }

  // --- Auth email update BEFORE Firestore (same UID) ---
  let authEmailUpdated = false;
  if (nextEmail) {
    try {
      await auth.updateUser(targetUid, {
        email: nextEmail,
        emailVerified: false,
      });
      authEmailUpdated = true;
    } catch (err) {
      throw userError(
        "internal",
        `Firebase Auth email update failed: ${
          err instanceof Error ? err.message : "unknown"
        }`,
        { failure: "firebase_auth_update_failed" },
      );
    }
  }

  // Auth displayName if changed
  if (firestorePatch.displayName) {
    try {
      await auth.updateUser(targetUid, {
        displayName: String(firestorePatch.displayName),
      });
    } catch {
      /* non-fatal — Firestore is source of truth for portal name */
    }
  }

  // Auth disabled flag if status changed
  if (nextStatus) {
    try {
      await auth.updateUser(targetUid, { disabled: nextStatus === "inactive" });
    } catch (err) {
      if (authEmailUpdated) {
        try {
          await auth.updateUser(targetUid, { email: previousEmail });
        } catch {
          /* compensation best-effort */
        }
      }
      throw userError(
        "internal",
        `Firebase Auth status update failed: ${
          err instanceof Error ? err.message : "unknown"
        }`,
        { failure: "firebase_auth_update_failed" },
      );
    }
  }

  try {
    await db.collection("users").doc(targetUid).update(firestorePatch);
  } catch (err) {
    // Compensate Auth email if Firestore fails
    if (authEmailUpdated) {
      try {
        await auth.updateUser(targetUid, { email: previousEmail });
      } catch {
        /* leave diagnostic */
      }
    }
    if (nextStatus) {
      try {
        await auth.updateUser(targetUid, {
          disabled: previousStatus === "inactive",
        });
      } catch {
        /* leave diagnostic */
      }
    }
    throw userError(
      "internal",
      `Firestore update failed: ${err instanceof Error ? err.message : "unknown"}`,
      { failure: "firestore_update_failed" },
    );
  }

  // Company membership sync on role/status changes
  const effectiveRole = (nextRole || targetRole) as RoleId;
  const effectiveStatus = nextStatus || previousStatus;
  const companyId = (data.companyId as string | null) || null;
  if (companyId && !isPlatformAdminRole(effectiveRole)) {
    if (effectiveStatus === "inactive") {
      await syncCompanyMembership({
        companyId,
        uid: targetUid,
        role:
          effectiveRole === ROLE_IDS.MANAGER
            ? ROLE_IDS.MANAGER
            : ROLE_IDS.REPRESENTATIVE,
        remove: true,
      });
    } else if (nextRole || nextStatus === "active") {
      // Role swap: remove from old bucket then add to new
      if (nextRole && targetRole !== nextRole) {
        await syncCompanyMembership({
          companyId,
          uid: targetUid,
          role:
            targetRole === ROLE_IDS.MANAGER
              ? ROLE_IDS.MANAGER
              : ROLE_IDS.REPRESENTATIVE,
          remove: true,
        });
      }
      await syncCompanyMembership({
        companyId,
        uid: targetUid,
        role:
          effectiveRole === ROLE_IDS.MANAGER
            ? ROLE_IDS.MANAGER
            : ROLE_IDS.REPRESENTATIVE,
      });
    }
  }

  await syncUserClaims(targetUid);

  const actorType = ctx.isPlatformAdmin ? "administrator" : "representative";

  await writeAuditEvent({
    type: AUDIT_EVENT.USER_UPDATED,
    actorUid: ctx.uid,
    actorType,
    payload: {
      targetUid,
      fieldsChanged,
      before: {
        displayName: data.displayName ?? null,
        email: previousEmail || null,
        phone: data.phone ?? null,
        title: data.title ?? null,
        role: targetRole,
        status: previousStatus,
      },
      after: {
        displayName: firestorePatch.displayName ?? data.displayName ?? null,
        email: nextEmail || previousEmail || null,
        phone: firestorePatch.phone !== undefined ? firestorePatch.phone : data.phone ?? null,
        title: firestorePatch.title !== undefined ? firestorePatch.title : data.title ?? null,
        role: nextRole || targetRole,
        status: nextStatus || previousStatus,
      },
    },
  });

  if (nextEmail) {
    await writeAuditEvent({
      type: AUDIT_EVENT.USER_EMAIL_CHANGED,
      actorUid: ctx.uid,
      actorType,
      payload: {
        targetUid,
        before: previousEmail,
        after: nextEmail,
      },
    });
  }
  if (nextRole) {
    await writeAuditEvent({
      type: AUDIT_EVENT.USER_ROLE_CHANGED,
      actorUid: ctx.uid,
      actorType,
      payload: {
        targetUid,
        before: targetRole,
        after: nextRole,
      },
    });
  }
  if (nextStatus === "inactive") {
    await writeAuditEvent({
      type: AUDIT_EVENT.USER_DEACTIVATED,
      actorUid: ctx.uid,
      actorType,
      payload: {
        targetUid,
        before: previousStatus,
        after: nextStatus,
        displayNameSnapshot: data.displayName || null,
        roleSnapshot: targetRole,
      },
    });
  } else if (nextStatus === "active") {
    await writeAuditEvent({
      type: AUDIT_EVENT.USER_REACTIVATED,
      actorUid: ctx.uid,
      actorType,
      payload: {
        targetUid,
        before: previousStatus,
        after: nextStatus,
      },
    });
  }
  if (presentationSettings) {
    await writeAuditEvent({
      type: AUDIT_EVENT.USER_ACCESS_POLICY_CHANGED,
      actorUid: ctx.uid,
      actorType,
      payload: {
        targetUid,
        before: previousPresentation,
        after: presentationSettings,
      },
    });
    await writeAuditEvent({
      type: AUDIT_EVENT.USER_PRESENTATION_ASSIGNMENT_CHANGED,
      actorUid: ctx.uid,
      actorType,
      payload: {
        targetUid,
        beforeVideoId: previousPresentation?.activeVideoId ?? null,
        afterVideoId: presentationSettings.activeVideoId,
      },
    });
  }

  return {
    ok: true,
    uid: targetUid,
    fieldsChanged,
    email: nextEmail || previousEmail,
  };
});

/**
 * Permanently delete a staff Auth account + active profile.
 * Preserves audit/legal/invite/session history (UID + name snapshots).
 */
export const deleteStaffUser = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.USERS_DELETE);
  if (!ctx.isPlatformAdmin) {
    throw userError(
      "permission-denied",
      "Permanent deletion requires a platform owner/administrator.",
      { failure: "insufficient_permission" },
    );
  }

  const targetUid = String(request.data?.uid || "").trim();
  if (!targetUid) throw userError("invalid-argument", "uid required.");

  const selfGuard = assertNotSelfDestructiveDelete({
    actorUid: ctx.uid,
    targetUid,
  });
  if (!selfGuard.ok) {
    throw userError("failed-precondition", selfGuard.reason, {
      failure: "self_protection",
    });
  }

  const snap = await db.collection("users").doc(targetUid).get();
  if (!snap.exists) throw userError("not-found", "User not found.");
  const data = snap.data()!;
  const targetRole = (data.primaryRole || data.roleIds?.[0]) as RoleId;
  const previousStatus = String(data.status || "active");

  if (!canActorModifyTargetRole({
    actorIsPlatformAdmin: ctx.isPlatformAdmin,
    targetRole,
  })) {
    throw userError(
      "permission-denied",
      "Insufficient permission to delete this user.",
      { failure: "insufficient_permission" },
    );
  }

  if (isPlatformAdminRole(targetRole)) {
    const owners = await listActivePlatformOwnerAdminUids();
    const guard = wouldRemoveLastPlatformOwner({
      targetUid,
      targetRole,
      targetStatus: previousStatus,
      action: "delete",
      activeOwnerAdminUids: owners,
    });
    if (!guard.ok) {
      throw userError("failed-precondition", guard.reason, {
        failure: "last_owner_protection",
      });
    }
  }

  const deps = await countActiveDependenciesForUser(targetUid);
  if (deps.activeInviteCount > 0 || deps.activeSessionCount > 0) {
    throw userError(
      "failed-precondition",
      formatUserDeletionBlockMessage({
        displayName: String(data.displayName || data.email || "This user"),
        activeInviteCount: deps.activeInviteCount,
        activeSessionCount: deps.activeSessionCount,
      }),
      {
        failure: "active_dependency_prevents_deletion",
        ...deps,
      },
    );
  }

  const tombstone = {
    uid: targetUid,
    email: data.email || null,
    displayName: data.displayName || null,
    primaryRole: targetRole,
    companyId: data.companyId ?? null,
    statusAtDeletion: previousStatus,
    deletedAt: nowIso(),
    deletedBy: ctx.uid,
    reason: "admin_permanent_delete",
  };

  try {
    await db.collection("users_deleted").doc(targetUid).set(tombstone);
  } catch (err) {
    throw userError(
      "internal",
      `Failed to write deletion tombstone: ${
        err instanceof Error ? err.message : "unknown"
      }`,
      { failure: "firestore_update_failed" },
    );
  }

  // Remove company membership arrays before profile delete
  if (data.companyId && !isPlatformAdminRole(targetRole)) {
    try {
      await syncCompanyMembership({
        companyId: String(data.companyId),
        uid: targetUid,
        role:
          targetRole === ROLE_IDS.MANAGER
            ? ROLE_IDS.MANAGER
            : ROLE_IDS.REPRESENTATIVE,
        remove: true,
      });
    } catch {
      /* non-fatal for deletion */
    }
  }

  let authDeleted = false;
  try {
    await auth.deleteUser(targetUid);
    authDeleted = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    // If Auth user already gone, continue with Firestore cleanup
    if (!/user.?not.?found/i.test(msg) && !/no user/i.test(msg)) {
      throw userError(
        "internal",
        `Firebase Auth delete failed: ${msg}`,
        { failure: "firebase_auth_update_failed" },
      );
    }
  }

  try {
    await db.collection("users").doc(targetUid).delete();
  } catch (err) {
    throw userError(
      "internal",
      `Firestore profile delete failed after Auth ${
        authDeleted ? "was removed" : "delete skipped"
      }: ${err instanceof Error ? err.message : "unknown"}. ` +
        `Tombstone retained at users_deleted/${targetUid}.`,
      {
        failure: "firestore_update_failed",
        authDeleted,
      },
    );
  }

  await writeAuditEvent({
    type: AUDIT_EVENT.USER_DELETED,
    actorUid: ctx.uid,
    actorType: "administrator",
    payload: {
      targetUid,
      emailSnapshot: data.email || null,
      displayNameSnapshot: data.displayName || null,
      roleSnapshot: targetRole,
      companyIdSnapshot: data.companyId ?? null,
      authDeleted,
      retainedHistoricalRecords: true,
    },
  });

  return {
    ok: true,
    uid: targetUid,
    authDeleted,
    message:
      "User account removed. Historical audit/legal/invite records were preserved.",
  };
});
