import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { httpsCallable } from "firebase/functions";
import { PERMISSIONS, ROLE_IDS, type Company, type RoleId } from "@spp/shared";
import { functions } from "@/lib/firebase";
import { formatDateTime } from "@/lib/format";
import { useAuth } from "@/modules/auth/AuthProvider";
import { StaffNav } from "@/components/StaffNav";

interface StaffUserRow {
  uid: string;
  email: string;
  displayName: string;
  primaryRole: RoleId | null;
  companyId: string | null;
  status: "active" | "inactive" | "disabled";
  createdAt: string | null;
  updatedAt: string | null;
}

type CompanyRow = Company & { id: string };

export function UsersPage() {
  const { hasPermission, companyId: ownCompanyId } = useAuth();
  const canManagePlatform = hasPermission(PERMISSIONS.USERS_MANAGE);
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
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Company</th>
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
                    <td>
                      <span className="badge">{u.status}</span>
                    </td>
                    <td>{formatDateTime(u.createdAt)}</td>
                    <td>
                      <div className="inline-actions">
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
