import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { httpsCallable } from "firebase/functions";
import { PERMISSIONS } from "@spp/shared";
import { functions } from "@/lib/firebase";
import { useAuth } from "@/modules/auth/AuthProvider";
import { ContentTools } from "./ContentTools";

export function BootstrapPage() {
  const { user, refreshClaims, signOut, hasPermission } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const callable = httpsCallable(functions, "bootstrapAdmin");
      const res = await callable({ displayName, companyName });
      await refreshClaims();
      setResult(JSON.stringify(res.data, null, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bootstrap failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <div className="page-center">
        <div className="panel">
          <p>
            <Link to="/login">Sign in</Link> first, then return here to bootstrap.
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
          <h1>Bootstrap portal</h1>
        </div>
        <button type="button" className="ghost" onClick={() => signOut()}>
          Sign out
        </button>
      </header>
      <section className="panel">
        <p className="muted">
          First signed-in user can initialize roles, placeholder legal documents,
          settings, and an active video metadata record. Replace placeholders and
          upload the MP4 before inviting real clients.
        </p>
        <form className="stack-form" onSubmit={onSubmit}>
          <label>
            Display name
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Dan"
            />
          </label>
          <label>
            Company name
            <input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Mike's Company"
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "Bootstrapping…" : "Run bootstrap"}
          </button>
        </form>
        {error ? <p className="error">{error}</p> : null}
        {result ? <pre className="code-block">{result}</pre> : null}
      </section>

      {hasPermission(PERMISSIONS.LEGAL_MANAGE) ||
      hasPermission(PERMISSIONS.VIDEOS_MANAGE) ? (
        <>
          <h2 style={{ marginTop: "1.5rem" }}>Content tools</h2>
          <ContentTools />
        </>
      ) : null}

      <p style={{ marginTop: "1.5rem" }}>
        <Link to="/app">Go to dashboard</Link>
      </p>
    </div>
  );
}
