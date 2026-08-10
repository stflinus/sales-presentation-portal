import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { httpsCallable } from "firebase/functions";
import { PERMISSIONS, type Company } from "@spp/shared";
import { functions } from "@/lib/firebase";
import { formatDateTime } from "@/lib/format";
import { useAuth } from "@/modules/auth/AuthProvider";
import { StaffNav } from "@/components/StaffNav";

type CompanyRow = Company & { id: string };

interface CompanyDetails {
  company: CompanyRow;
  managers: Array<{ uid: string; email: string; displayName: string; status: string }>;
  representatives: Array<{ uid: string; email: string; displayName: string; status: string }>;
}

export function CompaniesPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.COMPANIES_MANAGE);

  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<CompanyDetails | null>(null);
  const [editingName, setEditingName] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const callable = httpsCallable(functions, "listCompanies");
      const result = await callable({});
      const data = result.data as { companies: CompanyRow[] };
      setCompanies(
        [...(data.companies || [])].sort((a, b) => a.name.localeCompare(b.name)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load companies.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canManage) void refresh();
    else setLoading(false);
  }, [canManage, refresh]);

  async function createCompany(e: FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    setMessage(null);
    try {
      const callable = httpsCallable(functions, "createCompany");
      await callable({ name: newName.trim() });
      setNewName("");
      setMessage("Company created.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create company.");
    } finally {
      setCreating(false);
    }
  }

  async function toggleStatus(company: CompanyRow) {
    setBusyId(company.id);
    setError(null);
    setMessage(null);
    try {
      const callable = httpsCallable(functions, "updateCompany");
      const nextStatus = company.status === "active" ? "inactive" : "active";
      await callable({ companyId: company.id, status: nextStatus });
      setMessage(`Company ${nextStatus === "active" ? "activated" : "deactivated"}.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update company.");
    } finally {
      setBusyId(null);
    }
  }

  async function saveName(company: CompanyRow) {
    if (!editingName.trim() || editingName.trim() === company.name) {
      setSelected(null);
      return;
    }
    setBusyId(company.id);
    setError(null);
    try {
      const callable = httpsCallable(functions, "updateCompany");
      await callable({
        companyId: company.id,
        name: editingName.trim(),
      });
      setMessage("Company renamed.");
      await refresh();
      await viewDetails(company.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename company.");
    } finally {
      setBusyId(null);
    }
  }

  async function viewDetails(companyId: string) {
    setBusyId(companyId);
    setError(null);
    try {
      const callable = httpsCallable(functions, "getCompanyDetails");
      const result = await callable({ companyId });
      const data = result.data as CompanyDetails;
      setSelected(data);
      setEditingName(data.company.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load company details.");
    } finally {
      setBusyId(null);
    }
  }

  if (!canManage) {
    return (
      <div className="app-shell">
        <p>
          <Link to="/app">← Back to dashboard</Link>
        </p>
        <div className="panel">
          <h1>Companies</h1>
          <p className="muted">
            Platform administrator permission required (`companies:manage`).
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
          <h1>Companies</h1>
        </div>
        <StaffNav />
      </header>

      <section className="panel">
        <h2>Create company</h2>
        <form className="form-row" onSubmit={createCompany}>
          <label>
            Company name
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Acme Sales Group"
              required
            />
          </label>
          <button type="submit" disabled={creating}>
            {creating ? "Creating…" : "Create company"}
          </button>
        </form>
      </section>

      <section className="panel table-panel">
        <h2>All companies</h2>
        {loading ? <p className="muted">Loading…</p> : null}
        {!loading && companies.length === 0 ? (
          <p className="muted">No companies yet. Create one above.</p>
        ) : null}
        {companies.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Managers</th>
                  <th>Representatives</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {companies.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.name}</strong>
                      <div className="muted small">{c.id}</div>
                    </td>
                    <td>
                      <span className="badge">{c.status}</span>
                    </td>
                    <td>{(c.managerIds || []).length}</td>
                    <td>{(c.representativeIds || []).length}</td>
                    <td>{formatDateTime(c.createdAt)}</td>
                    <td>
                      <div className="inline-actions">
                        <button
                          type="button"
                          className="ghost"
                          disabled={busyId === c.id}
                          onClick={() => void viewDetails(c.id)}
                        >
                          Details
                        </button>
                        <Link
                          className="nav-link"
                          to={`/app/companies/${c.id}/email`}
                        >
                          Email
                        </Link>
                        <button
                          type="button"
                          className="ghost"
                          disabled={busyId === c.id}
                          onClick={() => void toggleStatus(c)}
                        >
                          {c.status === "active" ? "Deactivate" : "Activate"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {selected ? (
        <section className="panel">
          <div className="section-head">
            <h2>{selected.company.name}</h2>
            <p className="muted">Company ID: {selected.company.id}</p>
          </div>
          <form
            className="form-row"
            onSubmit={(e) => {
              e.preventDefault();
              void saveName(selected.company);
            }}
          >
            <label>
              Rename company
              <input
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
              />
            </label>
            <button type="submit" disabled={busyId === selected.company.id}>
              Save
            </button>
          </form>

          <section className="panel" style={{ marginTop: "1rem" }}>
            <h3>Email</h3>
            <p className="muted">
              Invitation delivery uses Firebase Trigger Email (mail queue).
            </p>
            <Link className="nav-link" to="/app/settings">
              Notification Settings →
            </Link>
          </section>

          <dl className="meta-list">
            <div>
              <dt>Active video</dt>
              <dd>{selected.company.activeVideoId || "—"}</dd>
            </div>
            <div>
              <dt>Active NDA</dt>
              <dd>{selected.company.activeNdaId || "—"}</dd>
            </div>
            <div>
              <dt>Active Terms</dt>
              <dd>{selected.company.activeTermsId || "—"}</dd>
            </div>
            <div>
              <dt>Active Privacy</dt>
              <dd>{selected.company.activePrivacyId || "—"}</dd>
            </div>
          </dl>

          <h3>Managers</h3>
          {selected.managers.length === 0 ? (
            <p className="muted">No managers assigned.</p>
          ) : (
            <ul className="plain-list">
              {selected.managers.map((m) => (
                <li key={m.uid}>
                  {m.displayName} · {m.email}{" "}
                  <span className="muted">({m.status})</span>
                </li>
              ))}
            </ul>
          )}

          <h3>Representatives</h3>
          {selected.representatives.length === 0 ? (
            <p className="muted">No representatives assigned.</p>
          ) : (
            <ul className="plain-list">
              {selected.representatives.map((r) => (
                <li key={r.uid}>
                  {r.displayName} · {r.email}{" "}
                  <span className="muted">({r.status})</span>
                </li>
              ))}
            </ul>
          )}

          <p style={{ marginTop: "1rem" }}>
            <Link to="/app/users">Manage users →</Link>
          </p>
          <button type="button" className="ghost" onClick={() => setSelected(null)}>
            Close
          </button>
        </section>
      ) : null}

      {message ? <p className="success">{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
