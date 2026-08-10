import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { httpsCallable } from "firebase/functions";
import { PERMISSIONS } from "@spp/shared";
import { functions } from "@/lib/firebase";
import { useAuth } from "@/modules/auth/AuthProvider";
import { StaffNav } from "@/components/StaffNav";
import { formatDateTime } from "@/lib/format";

interface EvidenceRow {
  id: string;
  contactName?: string;
  contactEmail?: string;
  contactId?: string | null;
  companyId?: string;
  representativeName?: string;
  invitationId?: string;
  sessionId?: string | null;
  acceptanceTimestamp?: string;
  ndaVersion?: string;
  termsVersion?: string;
  privacyVersion?: string;
  videoVersionId?: string;
}

export function LegalEvidenceVaultPage() {
  const { hasPermission, loading } = useAuth();
  const canRead =
    hasPermission(PERMISSIONS.LEGAL_EVIDENCE_READ_ALL) ||
    hasPermission(PERMISSIONS.LEGAL_EVIDENCE_READ_COMPANY);
  const canExport = hasPermission(PERMISSIONS.LEGAL_EVIDENCE_EXPORT);

  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [invitationId, setInvitationId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [orphanedOnly, setOrphanedOnly] = useState(false);
  const [results, setResults] = useState<EvidenceRow[]>([]);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const callable = httpsCallable(functions, "searchLegalEvidence");
      const result = await callable({
        contactName,
        contactEmail,
        invitationId,
        sessionId,
        orphanedOnly,
      });
      const data = result.data as { results: EvidenceRow[] };
      setResults(data.results || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  }, [contactName, contactEmail, invitationId, sessionId, orphanedOnly]);

  useEffect(() => {
    if (canRead) void search();
  }, [canRead, search]);

  if (loading) return null;
  if (!canRead) return <Navigate to="/app" replace />;

  async function openEvidence(id: string) {
    setBusy(true);
    setError(null);
    try {
      const callable = httpsCallable(functions, "getLegalEvidence");
      const result = await callable({ evidenceId: id });
      setSelected(result.data as Record<string, unknown>);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed.");
    } finally {
      setBusy(false);
    }
  }

  async function exportPackage(id: string) {
    if (!canExport) return;
    setBusy(true);
    setError(null);
    try {
      const callable = httpsCallable(functions, "exportLegalEvidencePackage");
      const result = await callable({ evidenceId: id });
      const data = result.data as {
        jsonPackage: unknown;
        jsonFileName: string;
        auditSummaryPdfBase64: string;
        auditSummaryPdfFileName: string;
      };
      downloadJson(data.jsonFileName, data.jsonPackage);
      downloadBase64Pdf(data.auditSummaryPdfFileName, data.auditSummaryPdfBase64);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  function onSearch(e: FormEvent) {
    e.preventDefault();
    void search();
  }

  const evidence = selected?.evidence as EvidenceRow | undefined;
  const timeline = selected?.timeline as Record<string, unknown> | undefined;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Append-only</p>
          <h1>Legal Evidence Vault</h1>
        </div>
        <StaffNav />
      </header>

      <section className="panel">
        <h2>Search</h2>
        <form className="stack-form" onSubmit={onSearch}>
          <label>
            Contact name
            <input value={contactName} onChange={(e) => setContactName(e.target.value)} />
          </label>
          <label>
            Contact email
            <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
          </label>
          <label>
            Invitation ID
            <input value={invitationId} onChange={(e) => setInvitationId(e.target.value)} />
          </label>
          <label>
            Session ID
            <input value={sessionId} onChange={(e) => setSessionId(e.target.value)} />
          </label>
          <label className="muted">
            <input
              type="checkbox"
              checked={orphanedOnly}
              onChange={(e) => setOrphanedOnly(e.target.checked)}
            />{" "}
            Orphaned only (Contact deleted)
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "Searching…" : "Search"}
          </button>
        </form>
      </section>

      {error ? <p className="error">{error}</p> : null}

      <section className="panel table-panel">
        <h2>Results ({results.length})</h2>
        {results.length === 0 ? (
          <p className="muted">No evidence records match.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Contact</th>
                  <th>Accepted</th>
                  <th>Company</th>
                  <th>Orphaned</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.contactName}
                      <div className="muted small">{r.contactEmail}</div>
                    </td>
                    <td>{formatDateTime(r.acceptanceTimestamp)}</td>
                    <td className="muted small">{r.companyId}</td>
                    <td>{r.contactId ? "No" : "Yes"}</td>
                    <td>
                      <button type="button" className="ghost" onClick={() => void openEvidence(r.id)}>
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && evidence ? (
        <section className="panel">
          <h2>Evidence detail</h2>
          <dl className="meta-list">
            <div>
              <dt>Evidence ID</dt>
              <dd>{evidence.id}</dd>
            </div>
            <div>
              <dt>Contact snapshot</dt>
              <dd>
                {evidence.contactName} &lt;{evidence.contactEmail}&gt;
              </dd>
            </div>
            <div>
              <dt>Contact ID</dt>
              <dd>{evidence.contactId || "null (orphaned)"}</dd>
            </div>
            <div>
              <dt>Representative</dt>
              <dd>{String((selected.evidence as { representativeName?: string }).representativeName)}</dd>
            </div>
            <div>
              <dt>Invitation</dt>
              <dd>{evidence.invitationId}</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>
                {evidence.sessionId ? (
                  <Link to={`/app/sessions/${evidence.sessionId}`}>
                    {evidence.sessionId}
                  </Link>
                ) : (
                  "null (presentation deleted)"
                )}
              </dd>
            </div>
            <div>
              <dt>Acceptance</dt>
              <dd>{formatDateTime(evidence.acceptanceTimestamp)}</dd>
            </div>
            <div>
              <dt>NDA / Terms / Privacy</dt>
              <dd>
                {evidence.ndaVersion} / {evidence.termsVersion} / {evidence.privacyVersion}
              </dd>
            </div>
            <div>
              <dt>SHA-256 (NDA)</dt>
              <dd className="small">{String((selected.evidence as { ndaContentSha256?: string }).ndaContentSha256)}</dd>
            </div>
            <div>
              <dt>Presentation completed</dt>
              <dd>{formatDateTime(timeline?.presentationCompletedAt as string | undefined)}</dd>
            </div>
            <div>
              <dt>Video version</dt>
              <dd>{String(timeline?.videoVersionId || evidence.videoVersionId || "—")}</dd>
            </div>
          </dl>
          {canExport ? (
            <button type="button" disabled={busy} onClick={() => void exportPackage(evidence.id)}>
              Export Audit Package
            </button>
          ) : (
            <p className="muted">Export requires legal_evidence:export permission.</p>
          )}
          <button type="button" className="ghost" onClick={() => setSelected(null)}>
            Close
          </button>
        </section>
      ) : null}
    </div>
  );
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadBase64Pdf(filename: string, base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
