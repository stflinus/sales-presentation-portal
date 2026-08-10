import { useNavigate, useSearchParams } from "react-router-dom";
import { TermsDocumentHtml } from "./TermsDocumentHtml";
import { getActiveTermsVersion } from "./versions";
import "../nda/nda.css";
import "./terms.css";

function formatDisplayDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return isoDate;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function TermsPage() {
  const version = getActiveTermsVersion();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const fromClient =
    params.get("from") === "client" || params.get("embed") === "1";

  function handleReturn() {
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    window.close();
  }

  return (
    <div className="nda-page">
      <header className="nda-page-header no-print">
        <div className="nda-page-header-inner">
          <p className="nda-eyebrow">Client Legal Document</p>
          <h1>{version.title}</h1>
          <dl className="nda-meta">
            <div>
              <dt>Effective Date</dt>
              <dd>{formatDisplayDate(version.effectiveDate)}</dd>
            </div>
            <div>
              <dt>Version Number</dt>
              <dd>{version.versionNumber}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>Published</dd>
            </div>
            <div>
              <dt>Document Type</dt>
              <dd>Terms</dd>
            </div>
          </dl>
          <div className="nda-actions">
            <button type="button" className="nda-btn" onClick={() => window.print()}>
              Print
            </button>
            {fromClient ? (
              <button
                type="button"
                className="nda-btn nda-btn-secondary"
                onClick={handleReturn}
              >
                Return
              </button>
            ) : (
              <button
                type="button"
                className="nda-btn nda-btn-secondary"
                onClick={handleReturn}
              >
                Close
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="nda-page-main">
        <div className="nda-print-meta print-only" aria-hidden="true">
          <p>
            <strong>{version.title}</strong>
          </p>
          <p>
            Effective Date: {formatDisplayDate(version.effectiveDate)} · Version{" "}
            {version.versionNumber}
          </p>
        </div>
        <TermsDocumentHtml />
      </main>

      <footer className="nda-page-footer no-print">
        <p>
          Previous version: {version.previousVersion ?? "None (initial version)"}
        </p>
      </footer>
    </div>
  );
}
