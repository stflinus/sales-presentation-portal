import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { doc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { PERMISSIONS, type PresentationSession } from "@spp/shared";
import { db, functions } from "@/lib/firebase";
import { formatDateTime } from "@/lib/format";
import { PresentationStatusBadges } from "@/components/StatusBadge";
import { useAuth } from "@/modules/auth/AuthProvider";
import { PresentationHealthPanel } from "./PresentationHealthPanel";
import { staffFriendlyError } from "@/lib/staffErrors";

interface LegalStatus {
  legalAccepted: boolean;
  ndaAccepted: boolean;
  termsAccepted: boolean;
  privacyAccepted: boolean;
  acceptanceTimestamp: string | null;
}

/**
 * Session detail for Representatives — legal status only (no forensic fields).
 * Platform admins/managers with evidence perms can open the Vault for full records.
 */
export function SessionDetailPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { hasPermission } = useAuth();
  const canOpenVault =
    hasPermission(PERMISSIONS.LEGAL_EVIDENCE_READ_ALL) ||
    hasPermission(PERMISSIONS.LEGAL_EVIDENCE_READ_COMPANY);

  const [session, setSession] = useState<PresentationSession | null>(null);
  const [legalStatus, setLegalStatus] = useState<LegalStatus | null>(null);
  const [notes, setNotes] = useState("");
  const [followUpAt, setFollowUpAt] = useState("");
  const [followUpNotes, setFollowUpNotes] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    return onSnapshot(doc(db, "presentationSessions", sessionId), (snap) => {
      if (!snap.exists()) {
        setSession(null);
        return;
      }
      const data = snap.data() as PresentationSession;
      setSession({ ...data, id: snap.id });
      setNotes(data.representativeNotes || "");
      if (data.followUpAt) {
        const d = new Date(data.followUpAt);
        if (!Number.isNaN(d.getTime())) {
          const pad = (n: number) => String(n).padStart(2, "0");
          setFollowUpAt(
            `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
          );
        }
      }
      setFollowUpNotes(data.followUpNotes || "");
    });
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    void (async () => {
      try {
        const callable = httpsCallable(functions, "getSessionLegalStatus");
        const result = await callable({ sessionId });
        setLegalStatus(result.data as LegalStatus);
      } catch {
        setLegalStatus(null);
      }
    })();
  }, [sessionId, session?.legalAcceptanceId]);

  useEffect(() => {
    if (searchParams.get("followUp") === "1") {
      document.getElementById("follow-up")?.scrollIntoView({ behavior: "smooth" });
    }
  }, [searchParams, session]);

  async function saveNotes(e: FormEvent) {
    e.preventDefault();
    if (!sessionId) return;
    setError(null);
    try {
      const callable = httpsCallable(functions, "updateSessionNotes");
      await callable({ sessionId, notes });
      setMessage("Notes saved.");
    } catch (err) {
      setError(staffFriendlyError(err, "Failed to save notes."));
    }
  }

  async function scheduleFollowUp(e: FormEvent) {
    e.preventDefault();
    if (!sessionId) return;
    setError(null);
    try {
      const callable = httpsCallable(functions, "scheduleFollowUp");
      const local = followUpAt; // YYYY-MM-DDTHH:mm
      await callable({
        sessionId,
        scheduledAt: new Date(followUpAt).toISOString(),
        followUpDate: local.slice(0, 10),
        followUpTime: local.slice(11, 16),
        notes: followUpNotes,
      });
      setMessage(
        session?.followUpStatus === "scheduled"
          ? "Follow-up updated on this Presentation."
          : "Follow-up scheduled on this Presentation.",
      );
    } catch (err) {
      setError(staffFriendlyError(err, "Failed to schedule follow-up."));
    }
  }

  async function resetInterrupted() {
    if (!sessionId) return;
    setError(null);
    try {
      const callable = httpsCallable(functions, "resetInterruptedSession");
      await callable({
        sessionId,
        reason: "Representative reset after interrupted viewing",
      });
      setMessage(
        "Interrupted viewing lease cleared. Contact may reopen the invitation. Completed sessions cannot be reset.",
      );
    } catch (err) {
      setError(staffFriendlyError(err, "Reset failed. Please try again."));
    }
  }

  async function confirmDeletePresentation() {
    if (!sessionId || deleteConfirmText !== "DELETE") return;
    setDeleteBusy(true);
    setError(null);
    try {
      const callable = httpsCallable(functions, "deletePresentation");
      await callable({ sessionId, confirm: "DELETE" });
      navigate("/app", { replace: true });
    } catch (err) {
      setError(staffFriendlyError(err, "Delete failed. Please try again."));
      setDeleteBusy(false);
    }
  }

  if (!session) {
    return (
      <div className="app-shell">
        <p className="muted">Loading session…</p>
      </div>
    );
  }

  const accepted = legalStatus?.legalAccepted || Boolean(session.legalAcceptanceId);

  return (
    <div className="app-shell">
      <p>
        <Link to="/app">← Back to dashboard</Link>
      </p>
      <header className="topbar">
        <div>
          <p className="eyebrow">Presentation</p>
          <h1>{session.clientName}</h1>
          <p className="muted">{session.clientEmail}</p>
        </div>
        <div className="topbar-actions">
          <button type="button" className="ghost" onClick={() => setShowActivity(true)}>
            Activity
          </button>
          <PresentationStatusBadges session={session} />
        </div>
      </header>

      <div className="dashboard-grid">
        <section className="panel">
          <h2>Status</h2>
          <dl className="meta-list">
            <div>
              <dt>Invitation</dt>
              <dd>
                <PresentationStatusBadges session={session} />
              </dd>
            </div>
            <div>
              <dt>Legal Accepted</dt>
              <dd>{accepted ? "Yes" : "Pending"}</dd>
            </div>
            <div>
              <dt>NDA</dt>
              <dd>{accepted ? "✓" : "—"}</dd>
            </div>
            <div>
              <dt>Terms</dt>
              <dd>{accepted ? "✓" : "—"}</dd>
            </div>
            <div>
              <dt>Privacy</dt>
              <dd>{accepted ? "✓" : "—"}</dd>
            </div>
            <div>
              <dt>Acceptance Timestamp</dt>
              <dd>
                {formatDateTime(
                  legalStatus?.acceptanceTimestamp || undefined,
                )}
              </dd>
            </div>
          </dl>
          {canOpenVault ? (
            <p>
              <Link to="/app/legal-evidence">Open Legal Evidence Vault →</Link>
            </p>
          ) : null}
        </section>

        <section className="panel">
          <h2>Notes</h2>
          <form className="stack-form" onSubmit={saveNotes}>
            <textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} />
            <button type="submit">Save notes</button>
          </form>
        </section>
      </div>

      <section className="panel" id="follow-up">
        <h2>Follow-up</h2>
        <p className="muted">
          Stored on this Presentation — scheduling or changing never creates a
          second sales record.
        </p>
        {session.followUpStatus === "scheduled" && session.followUpAt ? (
          <p>
            Current: {formatDateTime(session.followUpAt)}
            {session.followUpReminderStatus
              ? ` · Reminder: ${session.followUpReminderStatus}`
              : ""}
          </p>
        ) : null}
        <form className="stack-form" onSubmit={scheduleFollowUp}>
          <label>
            Follow-Up Date &amp; Time
            <input
              type="datetime-local"
              required
              value={followUpAt}
              onChange={(e) => setFollowUpAt(e.target.value)}
            />
          </label>
          <label>
            Notes
            <textarea
              rows={3}
              value={followUpNotes}
              onChange={(e) => setFollowUpNotes(e.target.value)}
            />
          </label>
          <button type="submit">
            {session.followUpStatus === "scheduled"
              ? "Update follow-up"
              : "Schedule follow-up"}
          </button>
        </form>
      </section>

      <section className="panel">
        <h2>Interrupted viewing</h2>
        <button type="button" className="ghost" onClick={() => void resetInterrupted()}>
          Reset interrupted session
        </button>
      </section>

      <section className="panel">
        <h2>Delete Presentation</h2>
        <p className="muted">
          Permanently removes this sales record from the dashboard. Legal
          evidence and audit records are preserved.
        </p>
        {!showDeleteConfirm ? (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setShowDeleteConfirm(true);
              setDeleteConfirmText("");
            }}
          >
            Delete Presentation…
          </button>
        ) : (
          <div className="stack-form">
            <p>
              <strong>Delete Presentation?</strong>
            </p>
            <p>
              This permanently removes the operational sales record and related
              follow-up data.
              <br />
              Legal evidence and immutable audit records will be preserved.
            </p>
            <p>Type DELETE to confirm.</p>
            <label>
              Confirmation
              <input
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="DELETE"
                autoComplete="off"
                disabled={deleteBusy}
              />
            </label>
            <div className="topbar-actions">
              <button
                type="button"
                className="ghost"
                disabled={deleteBusy}
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeleteConfirmText("");
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleteBusy || deleteConfirmText !== "DELETE"}
                onClick={() => void confirmDeletePresentation()}
              >
                {deleteBusy ? "Deleting…" : "Delete Presentation"}
              </button>
            </div>
          </div>
        )}
      </section>

      {message ? <p className="success">{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {showActivity && sessionId ? (
        <PresentationHealthPanel
          sessionId={sessionId}
          clientName={session.clientName}
          onClose={() => setShowActivity(false)}
        />
      ) : null}
    </div>
  );
}
