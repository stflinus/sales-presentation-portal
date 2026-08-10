import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase";

export function ContentTools() {
  const [legalType, setLegalType] = useState<"nda" | "terms" | "privacy">("nda");
  const [versionLabel, setVersionLabel] = useState("1.0");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function publishLegal(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const callable = httpsCallable(functions, "publishLegalDocument");
      const res = await callable({
        type: legalType,
        versionLabel,
        title,
        body,
        activate: true,
      });
      setMessage(`Published ${legalType}: ${JSON.stringify(res.data)}`);
      setBody("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publish failed.");
    }
  }

  return (
    <div className="dashboard-grid">
      <section className="panel">
        <h2>Publish legal document</h2>
        <p className="muted">
          Creates a new immutable version and marks it Active. Prior active version is archived.
        </p>
        <form className="stack-form" onSubmit={publishLegal}>
          <label>
            Type
            <select
              value={legalType}
              onChange={(e) =>
                setLegalType(e.target.value as "nda" | "terms" | "privacy")
              }
            >
              <option value="nda">NDA</option>
              <option value="terms">Terms & Conditions</option>
              <option value="privacy">Privacy Policy</option>
            </select>
          </label>
          <label>
            Version label
            <input
              required
              value={versionLabel}
              onChange={(e) => setVersionLabel(e.target.value)}
            />
          </label>
          <label>
            Title
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            Full document text
            <textarea
              required
              rows={10}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Paste counsel-approved wording…"
            />
          </label>
          <button type="submit">Publish & activate</button>
        </form>
      </section>

      <section className="panel">
        <h2>Video Library</h2>
        <p className="muted">
          Upload, activate, deactivate, archive, and delete presentation videos from the
          production Video Library. Only one video can be Active at a time.
        </p>
        <p>
          <Link to="/app/videos">Open Video Library →</Link>
        </p>
      </section>

      {message ? <p className="success">{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
