import { useState, type FormEvent } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase";
import { staffFriendlyError } from "@/lib/staffErrors";
import { useAuth } from "@/modules/auth/AuthProvider";
import {
  PresentationCreatedDialog,
  type PresentationCreatedInfo,
} from "./PresentationCreatedDialog";

interface SendInviteResult {
  inviteId: string;
  sessionId: string;
  contactId: string;
  companyId?: string;
  companyName?: string;
  representativeName?: string;
  representativeEmail?: string | null;
  representativeTitle?: string | null;
  representativePhone?: string | null;
  clientName?: string;
  clientEmail?: string;
  inviteUrl?: string | null;
  notificationStatus: string;
  failureReason: string | null;
  emailSent: boolean;
  emailDeliveryAvailable?: boolean;
  expiresAt: string;
}

/**
 * Version 0.1 — create Presentation + secure invitation URL.
 * Delivery is manual via Copy Link / Open Email success dialog.
 */
export function InviteClientForm() {
  const { user } = useAuth();

  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [followUpAt, setFollowUpAt] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<PresentationCreatedInfo | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const create = httpsCallable(functions, "createInvite");
      const result = await create({ clientName, clientEmail });
      const data = result.data as SendInviteResult;

      if (!data.inviteUrl || !data.sessionId) {
        throw new Error("Presentation created but invitation URL was missing.");
      }

      if (notes.trim()) {
        try {
          const updateNotes = httpsCallable(functions, "updateSessionNotes");
          await updateNotes({ sessionId: data.sessionId, notes: notes.trim() });
        } catch {
          // notes optional
        }
      }

      if (followUpAt) {
        try {
          const schedule = httpsCallable(functions, "scheduleFollowUp");
          await schedule({
            sessionId: data.sessionId,
            scheduledAt: new Date(followUpAt).toISOString(),
            followUpDate: followUpAt.slice(0, 10),
            followUpTime: followUpAt.slice(11, 16),
            notes: notes.trim() || undefined,
          });
        } catch {
          // follow-up optional
        }
      }

      setCreated({
        sessionId: data.sessionId,
        clientName: data.clientName || clientName,
        clientEmail: data.clientEmail || clientEmail,
        companyName: data.companyName || "",
        representativeName:
          data.representativeName ||
          user?.displayName ||
          user?.email ||
          "Representative",
        representativeTitle: data.representativeTitle || null,
        representativePhone: data.representativePhone || null,
        representativeEmail:
          data.representativeEmail || user?.email || null,
        inviteUrl: data.inviteUrl,
      });
      setClientName("");
      setClientEmail("");
      setFollowUpAt("");
      setNotes("");
    } catch (err) {
      setError(
        staffFriendlyError(err, "Failed to create presentation. Please try again."),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" id="invite">
      <h2>New Presentation</h2>
      <p className="muted">
        Creates one Presentation with a secure invitation link. Share via Open
        in Email, Copy Email, or Copy Link — no automated email in Version 0.1.
      </p>

      <form className="stack-form" onSubmit={(e) => void onSubmit(e)}>
        <label>
          Client Name
          <input
            required
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            placeholder="Jane Client"
            disabled={busy || Boolean(created)}
            autoComplete="name"
          />
        </label>
        <label>
          Client Email
          <input
            type="email"
            required
            value={clientEmail}
            onChange={(e) => setClientEmail(e.target.value)}
            placeholder="jane@company.com"
            disabled={busy || Boolean(created)}
            autoComplete="email"
          />
        </label>
        <label>
          Follow-Up Date
          <input
            type="datetime-local"
            value={followUpAt}
            onChange={(e) => setFollowUpAt(e.target.value)}
            disabled={busy || Boolean(created)}
          />
        </label>
        <label>
          Notes
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            disabled={busy || Boolean(created)}
            placeholder="Optional notes for this presentation"
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button type="submit" disabled={busy || Boolean(created)}>
          {busy ? "Creating…" : "Create Presentation"}
        </button>
      </form>

      {created ? (
        <PresentationCreatedDialog
          info={created}
          onClose={() => setCreated(null)}
        />
      ) : null}
    </section>
  );
}
