import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { httpsCallable, type FunctionsError } from "firebase/functions";
import {
  ACCESS_POLICY,
  ADMIN_ACCESS_POLICY_OPTIONS,
  PERMISSIONS,
  ROLE_IDS,
  accessPolicyLabel,
  isPlatformAdminRole,
  simplifyAccessPolicyForAdmin,
  type AccessPolicy,
  type Company,
  type RoleId,
  type UserPresentationSettings,
} from "@spp/shared";
import { functions } from "@/lib/firebase";
import { formatDateTime } from "@/lib/format";
import { useAuth } from "@/modules/auth/AuthProvider";
import { StaffNav } from "@/components/StaffNav";

interface PresentationSummary {
  videoTitle: string;
  accessLabel: string;
}

interface StaffUserRow {
  uid: string;
  email: string;
  displayName: string;
  phone?: string | null;
  title?: string | null;
  primaryRole: RoleId | null;
  companyId: string | null;
  status: "active" | "inactive" | "disabled";
  createdAt: string | null;
  updatedAt: string | null;
  presentationSettings?: UserPresentationSettings | null;
  presentationSummary?: PresentationSummary | null;
}

interface SelectableVideo {
  id: string;
  title: string;
  companyId: string;
}

type CompanyRow = Company & { id: string };
type StatusFilter = "all" | "active" | "inactive";
type RoleFilter = "all" | RoleId;

function isPresentationAssignable(u: StaffUserRow): boolean {
  return (
    u.primaryRole === ROLE_IDS.REPRESENTATIVE || u.primaryRole === ROLE_IDS.MANAGER
  );
}

function callableErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "message" in err) {
    const fe = err as FunctionsError;
    const details = fe.details as { errorId?: string; failure?: string } | undefined;
    const base = fe.message || fallback;
    if (details?.errorId && !base.includes(details.errorId)) {
      return `${base} [${details.errorId}]`;
    }
    return base;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

export function UsersPage() {
  const {
    user,
    hasPermission,
    isPlatformAdmin,
    companyId: ownCompanyId,
    refreshClaims,
  } = useAuth();
  const canManagePlatform = hasPermission(PERMISSIONS.USERS_MANAGE);
  const canEditUsers =
    hasPermission(PERMISSIONS.USERS_EDIT) ||
    canManagePlatform ||
    hasPermission(PERMISSIONS.USERS_MANAGE_COMPANY);
  const canDeactivate =
    hasPermission(PERMISSIONS.USERS_DEACTIVATE) ||
    canManagePlatform ||
    hasPermission(PERMISSIONS.USERS_MANAGE_COMPANY);
  const canDeleteUsers =
    isPlatformAdmin &&
    (hasPermission(PERMISSIONS.USERS_DELETE) || canManagePlatform);
  const canChangeRole =
    isPlatformAdmin &&
    (hasPermission(PERMISSIONS.USERS_CHANGE_ROLE) || canManagePlatform);
  const canManagePresentationPolicies =
    isPlatformAdmin ||
    hasPermission(PERMISSIONS.PRESENTATION_POLICIES_MANAGE) ||
    hasPermission(PERMISSIONS.USERS_CHANGE_PRESENTATION_POLICY);
  const canManageCompany = hasPermission(PERMISSIONS.USERS_MANAGE_COMPANY);
  const canManage = canManagePlatform || canManageCompany || canEditUsers;
  const canPickCompany = hasPermission(PERMISSIONS.COMPANIES_MANAGE);

  const [users, setUsers] = useState<StaffUserRow[]>([]);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<{
    uid: string;
    password: string;
  } | null>(null);
  const [busyUid, setBusyUid] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<RoleId>(ROLE_IDS.REPRESENTATIVE);
  const [companyId, setCompanyId] = useState("");
  const [creating, setCreating] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");

  const [editingUser, setEditingUser] = useState<StaffUserRow | null>(null);
  const [settingsVideos, setSettingsVideos] = useState<SelectableVideo[]>([]);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editRole, setEditRole] = useState<RoleId>(ROLE_IDS.REPRESENTATIVE);
  const [editStatus, setEditStatus] = useState<"active" | "inactive">("active");
  const [activeVideoId, setActiveVideoId] = useState("");
  const [accessPolicy, setAccessPolicy] = useState<AccessPolicy>(
    ACCESS_POLICY.SINGLE_VIEW,
  );
  const [accessDurationDays, setAccessDurationDays] = useState(7);

  const [deleteTarget, setDeleteTarget] = useState<StaffUserRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refreshUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const callable = httpsCallable(functions, "listStaffUsers");
      const result = await callable({});
      const data = result.data as { users: StaffUserRow[] };
      setUsers(data.users || []);
    } catch (err) {
      setError(callableErrorMessage(err, "Unable to load users."));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshCompanies = useCallback(async () => {
    if (!canPickCompany) return;
    try {
      const callable = httpsCallable(functions, "listCompanies");
      const result = await callable({});
      const data = result.data as { companies: CompanyRow[] };
      setCompanies(
        [...(data.companies || [])].sort((a, b) => a.name.localeCompare(b.name)),
      );
    } catch {
      // Non-fatal
    }
  }, [canPickCompany]);

  useEffect(() => {
    if (canManage) {
      void refreshUsers();
      void refreshCompanies();
    } else {
      setLoading(false);
    }
  }, [canManage, refreshUsers, refreshCompanies]);

  useEffect(() => {
    if (isPlatformAdmin) {
      void refreshClaims();
    }
  }, [isPlatformAdmin, refreshClaims]);

  const filteredUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return users.filter((u) => {
      if (statusFilter === "active" && u.status !== "active") return false;
      if (
        statusFilter === "inactive" &&
        u.status !== "inactive" &&
        u.status !== "disabled"
      ) {
        return false;
      }
      if (roleFilter !== "all" && u.primaryRole !== roleFilter) return false;
      if (!q) return true;
      const name = String(u.displayName || "").toLowerCase();
      const mail = String(u.email || "").toLowerCase();
      return name.includes(q) || mail.includes(q);
    });
  }, [users, searchQuery, statusFilter, roleFilter]);

  async function openEditUser(u: StaffUserRow) {
    if (!canEditUsers) return;
    setEditingUser(u);
    setEditName(u.displayName || "");
    setEditEmail(u.email || "");
    setEditPhone(u.phone || "");
    setEditRole(
      (u.primaryRole as RoleId) || ROLE_IDS.REPRESENTATIVE,
    );
    setEditStatus(u.status === "active" ? "active" : "inactive");
    setSettingsVideos([]);
    setActiveVideoId("");
    setAccessPolicy(ACCESS_POLICY.SINGLE_VIEW);
    setAccessDurationDays(7);
    setError(null);

    if (canManagePresentationPolicies && isPresentationAssignable(u)) {
      setSettingsLoading(true);
      try {
        const callable = httpsCallable(functions, "getStaffPresentationSettings");
        const result = await callable({ uid: u.uid });
        const data = result.data as {
          presentationSettings: UserPresentationSettings | null;
          videos: SelectableVideo[];
          companyActiveVideoId: string | null;
        };
        setSettingsVideos(data.videos || []);
        const ps = data.presentationSettings;
        setActiveVideoId(
          String(ps?.activeVideoId || data.companyActiveVideoId || ""),
        );
        setAccessPolicy(simplifyAccessPolicyForAdmin(ps?.accessPolicy));
        setAccessDurationDays(ps?.accessDurationDays ?? 7);
      } catch (err) {
        setError(callableErrorMessage(err, "Unable to load presentation settings."));
      } finally {
        setSettingsLoading(false);
      }
    }
  }

  function closeEditUser() {
    setEditingUser(null);
    setSettingsVideos([]);
  }

  async function saveEditUser(e: FormEvent) {
    e.preventDefault();
    if (!editingUser) return;
    setSettingsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const payload: Record<string, unknown> = {
        uid: editingUser.uid,
        displayName: editName.trim(),
        phone: editPhone.trim() || null,
      };
      if (canManagePlatform) {
        payload.email = editEmail.trim().toLowerCase();
      }
      if (canChangeRole && !isPlatformAdminRole(editingUser.primaryRole)) {
        payload.role = editRole;
      }
      if (canDeactivate) {
        payload.status = editStatus;
      }
      if (
        canManagePresentationPolicies &&
        isPresentationAssignable(editingUser) &&
        activeVideoId
      ) {
        payload.activeVideoId = activeVideoId;
        payload.accessPolicy = accessPolicy;
        payload.accessDurationDays =
          accessPolicy === ACCESS_POLICY.SINGLE_VIEW ? null : accessDurationDays;
      }

      const callable = httpsCallable(functions, "updateStaffUser");
      await callable(payload);
      setMessage(`Saved changes for ${editName.trim() || editingUser.displayName}.`);
      closeEditUser();
      await refreshUsers();
    } catch (err) {
      setError(callableErrorMessage(err, "Failed to save user changes."));
    } finally {
      setSettingsSaving(false);
    }
  }

  async function createUser(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    setMessage(null);
    setTempPassword(null);
    try {
      const callable = httpsCallable(functions, "createStaffUser");
      const payload: Record<string, unknown> = {
        email: email.trim(),
        displayName: displayName.trim(),
        role,
      };
      if (canPickCompany && companyId) payload.companyId = companyId;
      const result = await callable(payload);
      const data = result.data as {
        uid: string;
        temporaryPassword: string | null;
        message: string;
      };
      setMessage(data.message);
      if (data.temporaryPassword) {
        setTempPassword({ uid: data.uid, password: data.temporaryPassword });
      }
      setEmail("");
      setDisplayName("");
      await refreshUsers();
    } catch (err) {
      setError(callableErrorMessage(err, "Failed to create user."));
    } finally {
      setCreating(false);
    }
  }

  async function setStatus(uid: string, status: "active" | "inactive") {
    setBusyUid(uid);
    setError(null);
    setMessage(null);
    try {
      const callable = httpsCallable(functions, "setStaffUserStatus");
      await callable({ uid, status });
      setMessage(
        status === "active"
          ? "User reactivated. They can sign in and create invitations again."
          : "User deactivated. Login and new invitations are blocked; history is preserved.",
      );
      await refreshUsers();
    } catch (err) {
      setError(callableErrorMessage(err, "Failed to update user status."));
    } finally {
      setBusyUid(null);
    }
  }

  async function resetPassword(uid: string) {
    setBusyUid(uid);
    setError(null);
    setMessage(null);
    setTempPassword(null);
    try {
      const callable = httpsCallable(functions, "resetStaffTemporaryPassword");
      const result = await callable({ uid });
      const data = result.data as { temporaryPassword: string };
      setTempPassword({ uid, password: data.temporaryPassword });
      setMessage(
        "Temporary password generated. Share it securely — it will not be shown again.",
      );
    } catch (err) {
      setError(callableErrorMessage(err, "Failed to reset password."));
    } finally {
      setBusyUid(null);
    }
  }

  async function reassignCompany(uid: string, nextCompanyId: string) {
    if (!nextCompanyId) return;
    setBusyUid(uid);
    setError(null);
    try {
      const callable = httpsCallable(functions, "assignStaffCompany");
      await callable({ uid, companyId: nextCompanyId });
      setMessage("Company assignment updated.");
      await refreshUsers();
    } catch (err) {
      setError(callableErrorMessage(err, "Failed to reassign company."));
    } finally {
      setBusyUid(null);
    }
  }

  async function confirmDeleteUser() {
    if (!deleteTarget) return;
    setDeleting(true);
    setError(null);
    setMessage(null);
    try {
      const callable = httpsCallable(functions, "deleteStaffUser");
      await callable({ uid: deleteTarget.uid });
      setMessage(
        `${deleteTarget.displayName} permanently deleted. Audit and historical records were preserved.`,
      );
      setDeleteTarget(null);
      await refreshUsers();
    } catch (err) {
      setError(callableErrorMessage(err, "Failed to delete user."));
    } finally {
      setDeleting(false);
    }
  }

  function companyName(id: string | null): string {
    if (!id) return "—";
    return companies.find((c) => c.id === id)?.name || id;
  }

  function canEditRow(u: StaffUserRow): boolean {
    if (!canEditUsers) return false;
    if (isPlatformAdminRole(u.primaryRole) && !isPlatformAdmin) return false;
    return true;
  }

  function canDeleteRow(u: StaffUserRow): boolean {
    if (!canDeleteUsers) return false;
    if (user?.uid && u.uid === user.uid) return false;
    return true;
  }

  if (!canManage) {
    return (
      <div className="app-shell">
        <p>
          <Link to="/app">← Back to dashboard</Link>
        </p>
        <div className="panel">
          <h1>Users</h1>
          <p className="muted">
            User management permission required (`users:manage`,
            `users:manage_company`, or `users:edit`).
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>Users</h1>
          {!canManagePlatform && ownCompanyId ? (
            <p className="muted">Company: {ownCompanyId}</p>
          ) : null}
        </div>
        <StaffNav />
      </header>

      <section className="panel">
        <h2>Create manager or representative</h2>
        <form className="form-row" onSubmit={createUser}>
          <label>
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="rep@company.com"
            />
          </label>
          <label>
            Display name
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Jamie Rep"
            />
          </label>
          <label>
            Role
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as RoleId)}
            >
              <option value={ROLE_IDS.REPRESENTATIVE}>Representative</option>
              <option value={ROLE_IDS.MANAGER}>Company Manager</option>
            </select>
          </label>
          {canPickCompany ? (
            <label>
              Company
              <select
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
              >
                <option value="">Default company</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button type="submit" disabled={creating}>
            {creating ? "Creating…" : "Create user"}
          </button>
        </form>
      </section>

      <section className="panel table-panel">
        <h2>Staff users</h2>
        <div className="filter-bar users-filter-bar">
          <label>
            Search
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Name or email"
            />
          </label>
          <div className="filter-fields">
            <label>
              Status
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              >
                <option value="all">All</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>
            <label>
              Role
              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
              >
                <option value="all">All roles</option>
                <option value={ROLE_IDS.REPRESENTATIVE}>Representative</option>
                <option value={ROLE_IDS.MANAGER}>Manager</option>
                <option value={ROLE_IDS.ADMINISTRATOR}>Administrator</option>
                <option value={ROLE_IDS.OWNER}>Owner</option>
              </select>
            </label>
          </div>
        </div>

        {loading ? <p className="muted">Loading…</p> : null}
        {!loading && filteredUsers.length === 0 ? (
          <p className="muted">
            {users.length === 0 ? "No staff users yet." : "No users match your filters."}
          </p>
        ) : null}
        {filteredUsers.length > 0 ? (
          <div className="table-wrap">
            <table className="users-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Company</th>
                  {canManagePresentationPolicies ? <th>Presentation</th> : null}
                  <th>Status</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((u) => (
                  <tr key={u.uid}>
                    <td>
                      <strong>{u.displayName}</strong>
                      <div className="muted small">{u.email}</div>
                      {canManagePresentationPolicies &&
                      isPresentationAssignable(u) ? (
                        <div className="presentation-inline-summary mobile-only">
                          <div>
                            {u.presentationSummary?.videoTitle || "Company default"}
                          </div>
                          <div className="muted">
                            {u.presentationSummary?.accessLabel || "Single Viewing"}
                          </div>
                        </div>
                      ) : null}
                    </td>
                    <td>{u.primaryRole || "—"}</td>
                    <td>
                      {isPlatformAdminRole(u.primaryRole) ? (
                        "—"
                      ) : canPickCompany ? (
                        <select
                          value={u.companyId || ""}
                          disabled={busyUid === u.uid}
                          onChange={(e) =>
                            void reassignCompany(u.uid, e.target.value)
                          }
                        >
                          <option value="" disabled>
                            {companyName(u.companyId)}
                          </option>
                          {companies.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        companyName(u.companyId)
                      )}
                    </td>
                    {canManagePresentationPolicies ? (
                      <td className="presentation-cell desktop-only">
                        {isPresentationAssignable(u) ? (
                          <div className="presentation-compact">
                            <div>
                              {u.presentationSummary?.videoTitle ||
                                "Company default"}
                            </div>
                            <div className="muted small">
                              {u.presentationSummary?.accessLabel ||
                                "Single Viewing"}
                            </div>
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                    ) : null}
                    <td>
                      <span className="badge">{u.status}</span>
                    </td>
                    <td>{formatDateTime(u.createdAt)}</td>
                    <td>
                      <div className="inline-actions user-row-actions">
                        {canEditRow(u) ? (
                          <button
                            type="button"
                            className="ghost"
                            disabled={busyUid === u.uid}
                            onClick={() => void openEditUser(u)}
                          >
                            Edit
                          </button>
                        ) : null}
                        {canDeactivate ? (
                          <button
                            type="button"
                            className="ghost"
                            disabled={busyUid === u.uid || u.uid === user?.uid}
                            title={
                              u.uid === user?.uid
                                ? "You cannot deactivate your own account"
                                : u.status === "active"
                                  ? "Temporary — blocks login; history kept"
                                  : "Restore login access"
                            }
                            onClick={() =>
                              void setStatus(
                                u.uid,
                                u.status === "active" ? "inactive" : "active",
                              )
                            }
                          >
                            {u.status === "active" ? "Deactivate" : "Reactivate"}
                          </button>
                        ) : null}
                        {canManagePlatform && !isPlatformAdminRole(u.primaryRole) ? (
                          <button
                            type="button"
                            className="ghost"
                            disabled={busyUid === u.uid}
                            onClick={() => void resetPassword(u.uid)}
                          >
                            Reset password
                          </button>
                        ) : null}
                        {canDeleteRow(u) ? (
                          <button
                            type="button"
                            className="ghost danger-text"
                            disabled={busyUid === u.uid}
                            title="Permanent — removes Auth account; keeps audit history"
                            onClick={() => setDeleteTarget(u)}
                          >
                            Delete
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="muted small users-lifecycle-hint">
          Deactivate is temporary and reversible. Delete permanently removes the
          sign-in account but keeps audit, legal, and historical invite records.
        </p>
      </section>

      {editingUser ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-user-title"
        >
          <section className="panel modal-panel presentation-access-modal">
            <h2 id="edit-user-title">Edit user — {editingUser.displayName}</h2>
            {settingsLoading ? (
              <p className="muted">Loading…</p>
            ) : (
              <form className="form-stack" onSubmit={saveEditUser}>
                <label>
                  Name
                  <input
                    required
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                </label>
                <label>
                  Email
                  <input
                    type="email"
                    required
                    value={editEmail}
                    disabled={!canManagePlatform}
                    onChange={(e) => setEditEmail(e.target.value)}
                  />
                </label>
                {!canManagePlatform ? (
                  <p className="muted small">
                    Only platform administrators can change email addresses.
                  </p>
                ) : null}
                <label>
                  Phone
                  <input
                    type="tel"
                    value={editPhone}
                    onChange={(e) => setEditPhone(e.target.value)}
                    placeholder="Optional"
                  />
                </label>
                {canChangeRole && !isPlatformAdminRole(editingUser.primaryRole) ? (
                  <label>
                    Role
                    <select
                      value={editRole}
                      onChange={(e) => setEditRole(e.target.value as RoleId)}
                    >
                      <option value={ROLE_IDS.REPRESENTATIVE}>Rep</option>
                      <option value={ROLE_IDS.MANAGER}>Manager</option>
                    </select>
                  </label>
                ) : (
                  <p className="muted small">Role: {editingUser.primaryRole}</p>
                )}
                {canManagePresentationPolicies &&
                isPresentationAssignable(editingUser) ? (
                  <>
                    <label>
                      Assigned Presentation
                      <select
                        value={activeVideoId}
                        required
                        onChange={(e) => setActiveVideoId(e.target.value)}
                      >
                        <option value="" disabled>
                          Select a video
                        </option>
                        {settingsVideos.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Access Policy
                      <select
                        value={accessPolicy}
                        onChange={(e) =>
                          setAccessPolicy(e.target.value as AccessPolicy)
                        }
                      >
                        {ADMIN_ACCESS_POLICY_OPTIONS.map((policy) => (
                          <option key={policy} value={policy}>
                            {accessPolicyLabel(policy)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {accessPolicy === ACCESS_POLICY.TIME_LIMITED ? (
                      <label>
                        Access Duration (days)
                        <input
                          type="number"
                          min={1}
                          max={365}
                          required
                          value={accessDurationDays}
                          onChange={(e) =>
                            setAccessDurationDays(Number(e.target.value))
                          }
                        />
                      </label>
                    ) : null}
                    <p className="muted small">
                      Presentation settings apply to new invitations only.
                    </p>
                  </>
                ) : null}
                {canDeactivate ? (
                  <label>
                    Status
                    <select
                      value={editStatus}
                      disabled={editingUser.uid === user?.uid}
                      onChange={(e) =>
                        setEditStatus(e.target.value as "active" | "inactive")
                      }
                    >
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </label>
                ) : null}

                <div className="inline-actions">
                  <button type="button" className="ghost" onClick={closeEditUser}>
                    Cancel
                  </button>
                  <button type="submit" disabled={settingsSaving}>
                    {settingsSaving ? "Saving…" : "Save Changes"}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      ) : null}

      {deleteTarget ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-user-title"
        >
          <section className="panel modal-panel presentation-access-modal">
            <h2 id="delete-user-title">Permanently delete this user?</h2>
            <p>
              <strong>{deleteTarget.displayName}</strong> ({deleteTarget.email})
              will no longer be able to sign in. Historical audit/legal records
              that must be retained will not be deleted.
            </p>
            <p className="muted small">
              This cannot be undone. Prefer Deactivate if you may need the
              account again.
            </p>
            <div className="inline-actions">
              <button
                type="button"
                className="ghost"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                disabled={deleting}
                onClick={() => void confirmDeleteUser()}
              >
                {deleting ? "Deleting…" : "Delete User"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {tempPassword ? (
        <section className="panel">
          <h2>Temporary password</h2>
          <p className="muted">
            Shown once. Share it securely with the user — it is not stored
            anywhere and cannot be retrieved again from this screen.
          </p>
          <code className="invite-url">{tempPassword.password}</code>
        </section>
      ) : null}

      {message ? <p className="success">{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
