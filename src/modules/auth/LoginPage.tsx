import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { PERMISSIONS } from "@spp/shared";
import { useAuth } from "./AuthProvider";

export function LoginPage() {
  const { user, loading, signIn, hasPermission, refreshClaims } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!loading && user && hasPermission(PERMISSIONS.DASHBOARD_READ)) {
    return <Navigate to="/app" replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      await refreshClaims().catch(() => undefined);
      navigate("/app");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <form className="panel auth-panel" onSubmit={onSubmit}>
        <p className="eyebrow">Sales Presentation Portal</p>
        <h1>Representative login</h1>
        <p className="muted">
          Sign in to invite clients, track presentations, and schedule follow-ups.
        </p>
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button type="submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
