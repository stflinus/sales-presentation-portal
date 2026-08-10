import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { httpsCallable } from "firebase/functions";
import { CONTACT_STATUS, PERMISSIONS, type Contact } from "@spp/shared";
import { functions } from "@/lib/firebase";
import { useAuth } from "@/modules/auth/AuthProvider";
import { StaffNav } from "@/components/StaffNav";
import { statusLabel } from "@/lib/format";

export function ContactsPage() {
  const { hasPermission } = useAuth();
  const canManageCompany =
    hasPermission(PERMISSIONS.CONTACTS_MANAGE_COMPANY) ||
    hasPermission(PERMISSIONS.CONTACTS_MANAGE_ALL);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const callable = httpsCallable(functions, "listContacts");
      const result = await callable({ includeArchived });
      const data = result.data as { contacts: Contact[] };
      setContacts(data.contacts || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load contacts.");
    } finally {
      setLoading(false);
    }
  }, [includeArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const callable = httpsCallable(functions, "createContact");
      await callable({ displayName, email });
      setDisplayName("");
      setEmail("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Sales Hierarchy</p>
          <h1>My Contacts</h1>
        </div>
        <StaffNav />
      </header>

      <section className="panel" id="create-contact">
        <h2>Create Contact</h2>
        <form className="stack-form" onSubmit={onCreate}>
          <label>
            Contact name
            <input
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Jane Contact"
            />
          </label>
          <label>
            Contact email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@company.com"
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Create Contact"}
          </button>
        </form>
      </section>

      <section className="panel table-panel">
        <div className="section-head">
          <h2>Contacts</h2>
          {canManageCompany ? (
            <label className="muted">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
              />{" "}
              Include archived
            </label>
          ) : null}
        </div>
        {loading ? <p className="muted">Loading…</p> : null}
        {error ? <p className="error">{error}</p> : null}
        {!loading && contacts.length === 0 ? (
          <p className="muted">No contacts yet.</p>
        ) : null}
        {contacts.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/app/contacts/${c.id}`}>{c.displayName}</Link>
                    </td>
                    <td>{c.email}</td>
                    <td>
                      {c.status === CONTACT_STATUS.ARCHIVED
                        ? "Archived"
                        : statusLabel(c.status)}
                    </td>
                    <td className="muted small">{c.updatedAt?.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}
