import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLE_IDS,
  isPlatformAdminRole,
  type Permission,
  type RoleId,
  type UserProfile,
  type Company,
} from "../shared";
import { auth, db } from "./firebase";

export function requireAuth(request: CallableRequest): string {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  return request.auth.uid;
}

export function requirePermission(
  request: CallableRequest,
  permission: Permission,
): string {
  const uid = requireAuth(request);
  const permissions = (request.auth?.token?.permissions as string[] | undefined) ?? [];
  if (!permissions.includes(permission)) {
    throw new HttpsError("permission-denied", `Missing permission: ${permission}`);
  }
  return uid;
}

export function requireClientSession(
  request: CallableRequest,
  sessionId: string,
): string {
  const uid = requireAuth(request);
  if (request.auth?.token?.rolePrimary !== "client") {
    throw new HttpsError("permission-denied", "Client session required.");
  }
  if (request.auth?.token?.sessionId !== sessionId) {
    throw new HttpsError("permission-denied", "Session mismatch.");
  }
  return uid;
}

export interface StaffContext {
  uid: string;
  profile: UserProfile;
  permissions: Permission[];
  rolePrimary: RoleId;
  companyId: string | null;
  isPlatformAdmin: boolean;
}

export async function loadStaffContext(
  request: CallableRequest,
): Promise<StaffContext> {
  const uid = requireAuth(request);
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) {
    throw new HttpsError("failed-precondition", "Staff profile not found.");
  }
  const data = snap.data() as UserProfile;
  if (data.status === "disabled" || data.status === "inactive") {
    throw new HttpsError("permission-denied", "Account inactive.");
  }
  const roleIds = (data.roleIds as RoleId[]) || [];
  const rolePrimary = (data.primaryRole || roleIds[0] || ROLE_IDS.REPRESENTATIVE) as RoleId;
  const claimPerms = (request.auth?.token?.permissions as Permission[]) || [];
  const profilePerms = (data.permissions as Permission[]) || [];
  const permissions = (claimPerms.length ? claimPerms : profilePerms) as Permission[];
  const companyId = (data.companyId as string | null) ?? null;
  return {
    uid,
    profile: { ...data, uid },
    permissions,
    rolePrimary,
    companyId,
    isPlatformAdmin:
      permissions.includes(PERMISSIONS.COMPANIES_MANAGE) ||
      isPlatformAdminRole(rolePrimary),
  };
}

export function assertHasPermission(
  ctx: StaffContext,
  permission: Permission,
): void {
  if (!ctx.permissions.includes(permission)) {
    throw new HttpsError("permission-denied", `Missing permission: ${permission}`);
  }
}

/** Platform owner/administrator — per-rep presentation video & access policy. */
export function canManagePresentationPolicies(ctx: StaffContext): boolean {
  return (
    ctx.permissions.includes(PERMISSIONS.PRESENTATION_POLICIES_MANAGE) ||
    isPlatformAdminRole(ctx.rolePrimary)
  );
}

export function assertPresentationPoliciesManage(ctx: StaffContext): void {
  if (!canManagePresentationPolicies(ctx)) {
    throw new HttpsError(
      "permission-denied",
      "Missing presentation policy management permission.",
    );
  }
}

/**
 * Resolve the company the caller may act on.
 * Platform admins may pass companyId; others must use their assigned company.
 */
export function resolveActingCompanyId(
  ctx: StaffContext,
  requestedCompanyId?: string | null,
): string {
  if (ctx.isPlatformAdmin) {
    const id = (requestedCompanyId || ctx.companyId || "").trim();
    if (!id) {
      throw new HttpsError(
        "invalid-argument",
        "companyId required for platform administrator actions.",
      );
    }
    return id;
  }
  if (!ctx.companyId) {
    throw new HttpsError(
      "failed-precondition",
      "Staff user is not assigned to a company.",
    );
  }
  if (requestedCompanyId && requestedCompanyId !== ctx.companyId) {
    throw new HttpsError("permission-denied", "Cross-company access denied.");
  }
  return ctx.companyId;
}

export async function getCompanyOrThrow(companyId: string): Promise<Company> {
  const snap = await db.collection("companies").doc(companyId).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Company not found.");
  }
  const company = { id: snap.id, ...(snap.data() as Omit<Company, "id">) };
  if (company.status !== "active") {
    throw new HttpsError("failed-precondition", "Company is inactive.");
  }
  return company;
}

export async function assertSessionCompanyAccess(
  ctx: StaffContext,
  session: { representativeId?: string; companyId?: string },
): Promise<void> {
  if (ctx.isPlatformAdmin) return;
  if (ctx.permissions.includes(PERMISSIONS.SESSIONS_READ_COMPANY)) {
    if (!ctx.companyId || session.companyId !== ctx.companyId) {
      throw new HttpsError("permission-denied", "Cross-company access denied.");
    }
    return;
  }
  if (ctx.permissions.includes(PERMISSIONS.SESSIONS_READ_OWN)) {
    if (session.representativeId !== ctx.uid) {
      throw new HttpsError(
        "permission-denied",
        "Representatives may only access their own sessions.",
      );
    }
    if (ctx.companyId && session.companyId && session.companyId !== ctx.companyId) {
      throw new HttpsError("permission-denied", "Cross-company access denied.");
    }
    return;
  }
  throw new HttpsError("permission-denied", "Missing session read permission.");
}

export async function syncUserClaims(uid: string): Promise<string[]> {
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) {
    throw new HttpsError("not-found", "User profile not found.");
  }
  const data = userSnap.data()!;
  if (data.status === "disabled" || data.status === "inactive") {
    throw new HttpsError("permission-denied", "Account disabled.");
  }
  const roleIds = (data.roleIds as RoleId[]) ?? [];
  const permissionSet = new Set<string>();
  const rolePrimary =
    (data.primaryRole as RoleId) || roleIds[0] || ROLE_IDS.REPRESENTATIVE;
  const rolesToApply = roleIds.length > 0 ? roleIds : [rolePrimary];

  for (const roleId of rolesToApply) {
    const codePerms = ROLE_PERMISSIONS[roleId] ?? [];
    codePerms.forEach((p) => permissionSet.add(p));
    if (codePerms.length > 0) {
      await db.collection("roles").doc(roleId).set(
        {
          id: roleId,
          name: roleId,
          permissions: [...codePerms],
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
    const fromDb = await db.collection("roles").doc(roleId).get();
    const dbPerms = (fromDb.data()?.permissions as string[] | undefined) ?? [];
    dbPerms.forEach((p) => permissionSet.add(p));
  }

  const stored = (data.permissions as string[] | undefined) || [];
  stored.forEach((p) => permissionSet.add(p));

  const permissions = Array.from(permissionSet);
  const companyId = (data.companyId as string | null) ?? null;

  await auth.setCustomUserClaims(uid, {
    rolePrimary,
    roleIds,
    permissions,
    companyId,
    ver: Date.now(),
  });
  return permissions;
}

export function permissionsForRole(roleId: RoleId): Permission[] {
  return [...(ROLE_PERMISSIONS[roleId] || [])];
}
