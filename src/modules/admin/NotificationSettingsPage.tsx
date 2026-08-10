import { useEffect, useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { httpsCallable } from "firebase/functions";
import { PERMISSIONS } from "@spp/shared";
import { functions } from "@/lib/firebase";
import { useAuth } from "@/modules/auth/AuthProvider";
import { StaffNav } from "@/components/StaffNav";

interface NotificationSettings {
  defaultProvider: string;
  defaultSenderDisplayName: string;
  defaultInvitationSubject: string;
  defaultFooter: string;
}

interface FirebaseEmailStatus {
  provider: string;
  extension?: string;
  collection?: string;
  status: string;
  lastError: string | null;
  recentCount?: number;
}

function firebaseStatusLabel(status: string): string {
  switch (status) {
    case "configured":
      return "Configured";
    case "queue_healthy":
      return "Queue Healthy";
    case "queue_error":
      return "Queue Error";
    case "not_configured":
    default:
      return "Not Configured";
  }
}

function firebaseStatusClass(status: string): string {
  switch (status) {
    case "configured":
    case "queue_healthy":
      return "success";
    case "queue_error":
      return "error";
    default:
      return "muted";
  }
}

export function NotificationSettingsPage() {
  const { hasPermission, isPlatformAdmin, loading } = useAuth();
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [firebaseEmail, setFirebaseEmail] = useState<FirebaseEmailStatus | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testMessage, setTestMessage] = useState<string | null>(null);

  const canManage = hasPermission(PERMISSIONS.SETTINGS_MANAGE);

  async function refresh() {
    const callable = httpsCallable(functions, "getNotificationSettings");
    const result = await callable({});
    const data = result.data as {
      notifications: NotificationSettings;
      firebaseEmail: FirebaseEmailStatus;
    };
    setSettings(data.notifications);
    setFirebaseEmail(data.firebaseEmail);
  }

  useEffect(() => {
    if (!canManage) return;
    void refresh().catch((err) => {
      setError(err instanceof Error ? err.message : "Failed to load settings.");
    });
  }, [canManage]);

  if (loading) return null;
  if (!canManage) return <Navigate to="/app" replace />;

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const callable = httpsCallable(functions, "updateNotificationSettings");
      await callable({
        ...settings,
        markFirebaseEmailConfigured: true,
      });
      await refresh();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  async function onTestQueue() {
    setBusy(true);
    setError(null);
    setTestMessage(null);
    try {
      const callable = httpsCallable(functions, "testCompanyEmail");
      const result = await callable({
        companyId: "serenity-1",
        to: testTo.trim() || undefined,
      });
      const data = result.data as { ok: boolean; message?: string; mailId?: string };
      setTestMessage(
        data.message
          ? `✓ ${data.message}${data.mailId ? ` (mail/${data.mailId})` : ""}`
          : "✓ Email queued successfully.",
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test queue failed.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const status = firebaseEmail?.status || "not_configured";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Platform</p>
          <h1>Notification Settings</h1>
        </div>
        <StaffNav />
      </header>

      <section className="panel">
        <h2>Invitation Delivery</h2>
        <p className="muted">
          Version 0.1 uses a manual invitation workflow: create Presentation →
          Copy Link / Open Email. Automated Gmail delivery and Google Calendar
          sync are deferred to Version 0.2 via CalendarService.
        </p>
        <p>
          <strong>Status:</strong>{" "}
          <span className={firebaseStatusClass(status)}>
            {firebaseStatusLabel(status)}
          </span>
        </p>
        {firebaseEmail?.lastError ? (
          <p className="error small">{firebaseEmail.lastError}</p>
        ) : null}
        <p className="muted small">
          Extension: {firebaseEmail?.extension || "Trigger Email"} · Collection:{" "}
          {firebaseEmail?.collection || "mail"}
          {typeof firebaseEmail?.recentCount === "number"
            ? ` · Recent queue docs: ${firebaseEmail.recentCount}`
            : ""}
        </p>
        {isPlatformAdmin ? (
          <div className="stack-form" style={{ marginTop: 12 }}>
            <label>
              Test recipient (optional)
              <input
                type="email"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="Defaults to your admin email"
                disabled={busy}
              />
            </label>
            <div className="topbar-actions">
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => void onTestQueue()}
              >
                Queue Test Email
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void (async () => {
                    setBusy(true);
                    try {
                      const callable = httpsCallable(
                        functions,
                        "updateNotificationSettings",
                      );
                      await callable({ markFirebaseEmailConfigured: true });
                      await refresh();
                      setSaved(true);
                    } catch (err) {
                      setError(
                        err instanceof Error ? err.message : "Mark failed.",
                      );
                    } finally {
                      setBusy(false);
                    }
                  })();
                }}
              >
                Mark Extension Configured
              </button>
            </div>
          </div>
        ) : null}
        {testMessage ? <p className="success">{testMessage}</p> : null}
      </section>

      <section className="panel">
        <h2>Invitation defaults</h2>
        <p className="muted">
          Company display name brands the invitation. Representatives never
          enter email credentials.
        </p>
        {error ? <p className="error">{error}</p> : null}
        {saved ? <p className="success">Settings saved.</p> : null}
        {settings ? (
          <form className="stack-form" onSubmit={(e) => void onSave(e)}>
            <label>
              Provider
              <input value="Firebase Email" disabled readOnly />
            </label>
            <label>
              Default sender display name
              <input
                value={settings.defaultSenderDisplayName}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    defaultSenderDisplayName: e.target.value,
                  })
                }
              />
            </label>
            <label>
              Default invitation subject
              <input
                value={settings.defaultInvitationSubject}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    defaultInvitationSubject: e.target.value,
                  })
                }
              />
            </label>
            <label>
              Default footer
              <textarea
                rows={3}
                value={settings.defaultFooter}
                onChange={(e) =>
                  setSettings({ ...settings, defaultFooter: e.target.value })
                }
              />
            </label>
            <button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save settings"}
            </button>
          </form>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>
    </div>
  );
}
