import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { httpsCallable } from "firebase/functions";
import {
  ACCESS_POLICY,
  PERMISSIONS,
  ROLE_IDS,
  accessPolicyLabel,
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

/** Representatives and company managers receive per-user presentation configuration. */
function isPresentationAssignable(u: StaffUserRow): boolean {
  return (
    u.primaryRole === ROLE_IDS.REPRESENTATIVE || u.primaryRole === ROLE_IDS.MANAGER
  );
}

export function UsersPage() {
  const { hasPermission, isPlatformAdmin, companyId: ownCompanyId, refreshClaims } =
    useAuth();
  const canManagePlatform = hasPermission(PERMISSIONS.USERS_MANAGE);
  const canManagePresentationPolicies =
    isPlatformAdmin || hasPermission(PERMISSIONS.PRESENTATION_POLICIES_MANAGE);
  const canManageCompany = hasPermission(PERMISSIONS.USERS_MANAGE_COMPANY);
  const canManage = canManagePlatform || canManageCompany;
  const canPickCompany = hasPermission(PERMISSIONS.COMPANIES_MANAGE);

  const [users, setUsers] = useState<StaffUserRow[]>([]);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<{ uid: string; password: string } | null>(
    null,
  );
  const [busyUid, setBusyUid] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<RoleId>(ROLE_IDS.REPRESENTATIVE);
  const [companyId, setCompanyId] = useState("");
  const [creating, setCreating] = useState(false);

  const [editingUser, setEditingUser] = useState<StaffUserRow | null>(null);
  const [settingsVideos, setSettingsVideos] = useState<SelectableVideo[]>([]);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [activeVideoId, setActiveVideoId] = useState("");
  const [accessPolicy, setAccessPolicy] = useState<AccessPolicy>(ACCESS_POLICY.SINGLE_VIEW);
  const [accessDurationDays, setAccessDurationDays] = useState(7);

  const refreshUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const callable = httpsCallable(functions, "listStaffUsers");
      const result = await callable({});
      const data = result.data as { users: StaffUserRow[] };
      setUsers(data.users || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load users.");
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
      setCompanies([...(data.companies || [])].sort((a, b) => a.name.localeCompare(b.name)));
    } catch {
      // Non-fatal — company selection just won't be available.
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

  async function openPresentationAccess(u: StaffUserRow) {
    if (!canManagePresentationPolicies) return;
    setEditingUser(u);
    setSettingsLoading(true);
    setError(null);
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
      setActiveVideoId(String(ps?.activeVideoId || data.companyActiveVideoId || ""));
      setAccessPolicy(ps?.accessPolicy || ACCESS_POLICY.SINGLE_VIEW);
      setAccessDurationDays(ps?.accessDurationDays ?? 7);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load presentation access.");
      setEditingUser(null);
    } finally {
      setSettingsLoading(false);
    }
  }

  function closePresentationAccess() {
    setEditingUser(null);
    setSettingsVideos([]);
  }

  async function savePresentationAccess(e: FormEvent) {
    e.preventDefault();
    if (!editingUser) return;
    setSettingsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const callable = httpsCallable(functions, "updateStaffPresentationSettings");
      await callable({
        uid: editingUser.uid,
        activeVideoId: activeVideoId || null,
        accessPolicy,
        accessDurationDays:
          accessPolicy === ACCESS_POLICY.SINGLE_VIEW ? null : accessDurationDays,
      });
      setMessage(`Presentation access updated for ${editingUser.displayName}.`);
      closePresentationAccess();
      await refreshUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save presentation access.");
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
      setError(err instanceof Error ? err.message : "Failed to create user.");
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
      setMessage(`User ${status === "active" ? "activated" : "deactivated"}.`);
      await refreshUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update user status.");
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
      setMessage("Temporary password generated. Share it securely — it will not be shown again.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset password.");
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
      setError(err instanceof Error ? err.message : "Failed to reassign company.");
    } finally {
      setBusyUid(null);
    }
  }

  function companyName(id: string | null): string {
    if (!id) return "—";
    return companies.find((c) => c.id === id)?.name || id;
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
            User management permission required (`users:manage` or
            `users:manage_company`).
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
            <select value={role} onChange={(e) => setRole(e.target.value as RoleId)}>
              <option value={ROLE_IDS.REPRESENTATIVE}>Representative</option>
              <option value={ROLE_IDS.MANAGER}>Company Manager</option>
            </select>
          </label>
          {canPickCompany ? (
            <label>
              Company
              <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
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
        {loading ? <p className="muted">Loading…</p> : null}
        {!loading && users.length === 0 ? (
          <p className="muted">No staff users yet.</p>
        ) : null}
        {users.length > 0 ? (
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
                {users.map((u) => (
                  <tr key={u.uid}>
                    <td>
                      <strong>{u.displayName}</strong>
                      <div className="muted small">{u.email}</div>
                      {canManagePresentationPolicies && isPresentationAssignable(u) ? (
                        <div className="presentation-inline-summary mobile-only">
                          <div>{u.presentationSummary?.videoTitle || "Company default"}</div>
                          <div className="muted">
                            {u.presentationSummary?.accessLabel || "Single Viewing"}
                          </div>
                        </div>
                      ) : null}
                    </td>
                    <td>{u.primaryRole || "—"}</td>
                    <td>
                      {u.primaryRole === ROLE_IDS.ADMINISTRATOR ||
                      u.primaryRole === ROLE_IDS.OWNER ? (
                        "—"
                      ) : canPickCompany ? (
                        <select
                          value={u.companyId || ""}
                          disabled={busyUid === u.uid}
                          onChange={(e) => void reassignCompany(u.uid, e.target.value)}
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
                            <div>{u.presentationSummary?.videoTitle || "Company default"}</div>
                            <div className="muted small">
                              {u.presentationSummary?.accessLabel || "Single Viewing"}
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
                        {canManagePresentationPolicies && isPresentationAssignable(u) ? (
                          <button
                            type="button"
                            className="ghost"
                            disabled={busyUid === u.uid}
                            onClick={() => void openPresentationAccess(u)}
                          >
                            Presentation Access
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="ghost"
                          disabled={busyUid === u.uid}
                          onClick={() =>
                            void setStatus(
                              u.uid,
                              u.status === "active" ? "inactive" : "active",
                            )
                          }
                        >
                          {u.status === "active" ? "Deactivate" : "Activate"}
                        </button>
                        {canManagePlatform ? (
                          <button
                            type="button"
                            className="ghost"
                            disabled={busyUid === u.uid}
                            onClick={() => void resetPassword(u.uid)}
                          >
                            Reset password
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
      </section>

      {editingUser ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="presentation-access-title"
        >
          <section className="panel modal-panel presentation-access-modal">
            <h2 id="presentation-access-title">
              Presentation Access — {editingUser.displayName}
            </h2>
            <p className="muted">
              These settings apply to new invitations only. Existing invitations keep their
              original video and access policy.
            </p>
            {settingsLoading ? (
              <p className="muted">Loading…</p>
            ) : (
              <form className="form-stack" onSubmit={savePresentationAccess}>
                <label>
                  Assigned video
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

                <fieldset>
                  <legend>Access policy</legend>
                  <label className="radio-row">
                    <input
                      type="radio"
                      name="accessPolicy"
                      checked={accessPolicy === ACCESS_POLICY.SINGLE_VIEW}
                      onChange={() => setAccessPolicy(ACCESS_POLICY.SINGLE_VIEW)}
                    />
                    {accessPolicyLabel(ACCESS_POLICY.SINGLE_VIEW)}
                  </label>
                  <label className="radio-row">
                    <input
                      type="radio"
                      name="accessPolicy"
                      checked={accessPolicy === ACCESS_POLICY.TIME_LIMITED}
                      onChange={() => setAccessPolicy(ACCESS_POLICY.TIME_LIMITED)}
                    />
                    Time-Limited Access
                  </label>
                  {accessPolicy === ACCESS_POLICY.TIME_LIMITED ? (
                    <label>
                      Access duration (days)
                      <input
                        type="number"
                        min={1}
                        max={365}
                        required
                        value={accessDurationDays}
                        onChange={(e) => setAccessDurationDays(Number(e.target.value))}
                      />
                    </label>
                  ) : null}
                  <label className="radio-row">
                    <input
                      type="radio"
                      name="accessPolicy"
                      checked={accessPolicy === ACCESS_POLICY.SINGLE_VIEW_WITH_EXPIRATION}
                      onChange={() =>
                        setAccessPolicy(ACCESS_POLICY.SINGLE_VIEW_WITH_EXPIRATION)
                      }
                    />
                    {accessPolicyLabel(ACCESS_POLICY.SINGLE_VIEW_WITH_EXPIRATION)}
                  </label>
                  {accessPolicy === ACCESS_POLICY.SINGLE_VIEW_WITH_EXPIRATION ? (
                    <label>
                      Expires after (days)
                      <input
                        type="number"
                        min={1}
                        max={365}
                        required
                        value={accessDurationDays}
                        onChange={(e) => setAccessDurationDays(Number(e.target.value))}
                      />
                    </label>
                  ) : null}
                </fieldset>

                <div className="inline-actions">
                  <button type="button" className="ghost" onClick={closePresentationAccess}>
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

      {tempPassword ? (
        <section className="panel">
          <h2>Temporary password</h2>
          <p className="muted">
            Shown once. Share it securely with the user — it is not stored anywhere
            and cannot be retrieved again from this screen.
          </p>
          <code className="invite-url">{tempPassword.password}</code>
        </section>
      ) : null}

      {message ? <p className="success">{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
