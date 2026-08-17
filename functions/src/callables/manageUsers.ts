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
  loadStaffContext,
  permissionsForRole,
  resolveActingCompanyId,
  syncUserClaims,
} from "../lib/authz";
import { writeAuditEvent } from "../lib/audit";
import { auth, db } from "../lib/firebase";

function nowIso() {
  return new Date().toISOString();
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

  const videoIds = [
    ...new Set(
      users
        .map((u) => String(u.presentationSettings?.activeVideoId || "").trim())
        .filter(Boolean),
    ),
  ];
  const videoTitles = new Map<string, string>();
  await Promise.all(
    videoIds.map(async (id) => {
      const snap = await db.collection("videos").doc(id).get();
      if (snap.exists) {
        videoTitles.set(id, String(snap.data()?.title || id));
      }
    }),
  );

  const enriched = users.map((u) => {
    const ps = u.presentationSettings as Record<string, unknown> | null;
    const activeVideoId = String(ps?.activeVideoId || "").trim();
    const videoTitle = activeVideoId
      ? videoTitles.get(activeVideoId) || activeVideoId
      : "Company default";
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

/** Platform admin: read presentation settings + selectable videos for a staff user. */
export const getStaffPresentationSettings = onCall(async (request) => {
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

/** Platform admin: update per-user presentation video & access policy. */
export const updateStaffPresentationSettings = onCall(async (request) => {
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
    throw new HttpsError("failed-precondition", "Cannot configure platform administrators.");
  }
  const companyId = String(data.companyId || "");
  if (!companyId) throw new HttpsError("failed-precondition", "User has no company assignment.");

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
  const targetUid = String(request.data?.uid || "").trim();
  const status = String(request.data?.status || "").trim();
  if (!targetUid) throw new HttpsError("invalid-argument", "uid required.");
  if (status !== "active" && status !== "inactive") {
    throw new HttpsError("invalid-argument", "status must be active|inactive.");
  }

  const snap = await db.collection("users").doc(targetUid).get();
  if (!snap.exists) throw new HttpsError("not-found", "User not found.");
  const data = snap.data()!;
  const targetRole = (data.primaryRole || data.roleIds?.[0]) as RoleId;

  if (isPlatformAdminRole(targetRole) && targetUid !== ctx.uid) {
    if (!ctx.isPlatformAdmin) {
      throw new HttpsError(
        "permission-denied",
        "Cannot modify Platform Administrators.",
      );
    }
  }

  assertCanManageUsers(
    ctx,
    (data.companyId as string) || null,
    targetRole === ROLE_IDS.MANAGER || targetRole === ROLE_IDS.REPRESENTATIVE
      ? targetRole
      : ROLE_IDS.REPRESENTATIVE,
  );

  if (
    !ctx.isPlatformAdmin &&
    data.companyId &&
    data.companyId !== ctx.companyId
  ) {
    throw new HttpsError("permission-denied", "Cross-company access denied.");
  }

  await db.collection("users").doc(targetUid).update({
    status,
    updatedAt: nowIso(),
    updatedAtServer: FieldValue.serverTimestamp(),
  });

  if (status === "inactive") {
    await auth.updateUser(targetUid, { disabled: true });
    if (data.companyId) {
      await syncCompanyMembership({
        companyId: String(data.companyId),
        uid: targetUid,
        role: targetRole === ROLE_IDS.MANAGER ? ROLE_IDS.MANAGER : ROLE_IDS.REPRESENTATIVE,
        remove: true,
      });
    }
  } else {
    await auth.updateUser(targetUid, { disabled: false });
    if (data.companyId) {
      await syncCompanyMembership({
        companyId: String(data.companyId),
        uid: targetUid,
        role: targetRole === ROLE_IDS.MANAGER ? ROLE_IDS.MANAGER : ROLE_IDS.REPRESENTATIVE,
      });
    }
    await syncUserClaims(targetUid);
  }

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
