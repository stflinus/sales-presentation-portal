import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { httpsCallable } from "firebase/functions";
import { CONTACT_STATUS, PERMISSIONS, type Contact } from "@spp/shared";
import { functions } from "@/lib/firebase";
import { useAuth } from "@/modules/auth/AuthProvider";
import { StaffNav } from "@/components/StaffNav";
import { statusLabel } from "@/lib/format";

export function ContactDetailPage() {
  const { contactId = "" } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canManageCompany =
    hasPermission(PERMISSIONS.CONTACTS_MANAGE_COMPANY) ||
    hasPermission(PERMISSIONS.CONTACTS_MANAGE_ALL);
  const [contact, setContact] = useState<Contact | null>(null);
  const [reps, setReps] = useState<
    Array<{ uid: string; displayName: string; email: string }>
  >([]);
  const [newOwnerId, setNewOwnerId] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const callable = httpsCallable(functions, "getContact");
      const result = await callable({ contactId });
      const data = result.data as { contact: Contact };
      setContact(data.contact);
      setNotes(String(data.contact.notes || ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load contact.");
    }
  }, [contactId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canManageCompany) return;
    void (async () => {
      try {
        const callable = httpsCallable(functions, "listStaffUsers");
        const result = await callable({});
        const data = result.data as {
          users: Array<{
            uid: string;
            displayName: string;
            email: string;
            primaryRole: string;
          }>;
        };
        setReps(
          (data.users || []).filter(
            (u) =>
              u.primaryRole === "representative" || u.primaryRole === "manager",
          ),
        );
      } catch {
        // optional
      }
    })();
  }, [canManageCompany]);

  async function run(name: string, payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const callable = httpsCallable(functions, name);
      await callable(payload);
      if (name === "deleteContact") {
        navigate("/app/contacts");
        return;
      }
      setMessage("Saved.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!contact && !error) {
    return (
      <div className="app-shell">
        <StaffNav />
        <p className="muted">Loading contact…</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Contact</p>
          <h1>{contact?.displayName || "Contact"}</h1>
        </div>
        <StaffNav />
      </header>

      <p>
        <Link to="/app/contacts">← Back to contacts</Link>
      </p>
      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="success">{message}</p> : null}

      {contact ? (
        <>
          <section className="panel">
            <p>
              <strong>Email:</strong> {contact.email}
            </p>
            <p>
              <strong>Status:</strong> {statusLabel(contact.status)}
            </p>
            <p className="muted small">
              Owner: {contact.ownerRepresentativeId || "—"} · Company:{" "}
              {contact.companyId}
            </p>
            <label>
              Notes
              <textarea
                rows={4}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
            <div className="topbar-actions" style={{ marginTop: 12 }}>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run("updateContact", { contactId, notes })
                }
              >
                Save notes
              </button>
              <Link
                className="button"
                to={`/app?inviteContactId=${contact.id}`}
              >
                Invite Contact
              </Link>
            </div>
          </section>

          <section className="panel">
            <h2>Lifecycle</h2>
            <div className="topbar-actions">
              {contact.status !== CONTACT_STATUS.ARCHIVED &&
              contact.status !== CONTACT_STATUS.DELETED ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run("archiveContact", { contactId })}
                >
                  Archive
                </button>
              ) : null}
              {contact.status === CONTACT_STATUS.ARCHIVED && canManageCompany ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run("restoreContact", { contactId })}
                >
                  Restore
                </button>
              ) : null}
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "Delete this contact? Legal acceptances will be preserved as orphaned records.",
                    )
                  ) {
                    void run("deleteContact", { contactId, confirm: true });
                  }
                }}
              >
                Delete
              </button>
            </div>
          </section>

          {canManageCompany ? (
            <section className="panel">
              <h2>Reassign</h2>
              <label>
                New owner
                <select
                  value={newOwnerId}
                  onChange={(e) => setNewOwnerId(e.target.value)}
                >
                  <option value="">Select representative…</option>
                  {reps.map((r) => (
                    <option key={r.uid} value={r.uid}>
                      {r.displayName || r.email}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={busy || !newOwnerId}
                onClick={() =>
                  void run("reassignContact", {
                    contactId,
                    newOwnerRepresentativeId: newOwnerId,
                  })
                }
              >
                Transfer ownership
              </button>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
