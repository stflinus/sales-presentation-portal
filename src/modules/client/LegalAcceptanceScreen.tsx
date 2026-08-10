import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { httpsCallable } from "firebase/functions";
import type { LegalDocType } from "@spp/shared";
import { functions } from "@/lib/firebase";
import { NdaDocumentHtml } from "@/modules/legal/nda/NdaDocumentHtml";
import { getActiveNdaVersion } from "@/modules/legal/nda/versions";
import { TermsDocumentHtml } from "@/modules/legal/terms/TermsDocumentHtml";
import { getActiveTermsVersion } from "@/modules/legal/terms/versions";
import { PrivacyDocumentHtml } from "@/modules/legal/privacy/PrivacyDocumentHtml";
import { getActivePrivacyVersion } from "@/modules/legal/privacy/versions";
import "@/modules/legal/nda/nda.css";
import "./legalAcceptance.css";

type ModalDoc = LegalDocType | null;

interface LegalAcceptanceScreenProps {
  sessionId: string;
  busy: boolean;
  error: string | null;
  onAccept: (payload: {
    ndaChecked: boolean;
    termsPrivacyChecked: boolean;
    screenResolution: string;
  }) => Promise<void>;
}

function DocModal({
  title,
  versionLabel,
  effectiveDate,
  open,
  onClose,
  children,
  extraActions,
}: {
  title: string;
  versionLabel: string;
  effectiveDate: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  extraActions?: ReactNode;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="legal-modal-root" role="presentation">
      <button
        type="button"
        className="legal-modal-backdrop"
        aria-label="Close legal document"
        onClick={onClose}
      />
      <div
        className="legal-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="legal-modal-header no-print">
          <div>
            <h2 id={titleId}>{title}</h2>
            <p className="muted small">
              Version {versionLabel}
              {effectiveDate ? ` · Effective ${effectiveDate}` : ""}
            </p>
          </div>
          <div className="legal-modal-actions">
            {extraActions}
            <button type="button" className="nda-btn" onClick={() => window.print()}>
              Print
            </button>
            <button
              type="button"
              className="nda-btn nda-btn-secondary"
              ref={closeRef}
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </header>
        <div className="legal-modal-body">{children}</div>
      </div>
    </div>
  );
}

export function LegalAcceptanceScreen({
  sessionId,
  busy,
  error,
  onAccept,
}: LegalAcceptanceScreenProps) {
  const [ndaChecked, setNdaChecked] = useState(false);
  const [termsPrivacyChecked, setTermsPrivacyChecked] = useState(false);
  const [modal, setModal] = useState<ModalDoc>(null);
  const [viewEventId, setViewEventId] = useState<string | null>(null);

  const canContinue = ndaChecked && termsPrivacyChecked && !busy;
  const ndaMeta = getActiveNdaVersion();
  const termsMeta = getActiveTermsVersion();
  const privacyMeta = getActivePrivacyVersion();

  async function openDoc(type: LegalDocType) {
    setModal(type);
    try {
      const callable = httpsCallable(functions, "recordLegalDocumentView");
      const result = await callable({
        sessionId,
        documentType: type,
        action: "open",
      });
      const data = result.data as { viewEventId?: string };
      setViewEventId(data.viewEventId || null);
    } catch {
      setViewEventId(null);
    }
  }

  async function closeDoc() {
    const type = modal;
    const eventId = viewEventId;
    setModal(null);
    setViewEventId(null);
    if (!type || !eventId) return;
    try {
      const callable = httpsCallable(functions, "recordLegalDocumentView");
      await callable({
        sessionId,
        documentType: type,
        action: "close",
        viewEventId: eventId,
      });
    } catch {
      // Informational only — do not block acceptance.
    }
  }

  return (
    <div className="client-shell">
      <div className="panel client-panel legal-accept-panel">
        <h1 className="legal-accept-heading">
          Before continuing, please review and accept the required legal documents.
        </h1>

        <div className="legal-checkbox-stack">
          <label className="legal-checkbox-row">
            <input
              type="checkbox"
              checked={ndaChecked}
              onChange={(e) => setNdaChecked(e.target.checked)}
            />
            <span>
              I have read and agree to the{" "}
              <button
                type="button"
                className="legal-inline-link"
                onClick={() => void openDoc("nda")}
              >
                Non-Disclosure Agreement
              </button>
            </span>
          </label>

          <label className="legal-checkbox-row">
            <input
              type="checkbox"
              checked={termsPrivacyChecked}
              onChange={(e) => setTermsPrivacyChecked(e.target.checked)}
            />
            <span>
              I have read and agree to the{" "}
              <button
                type="button"
                className="legal-inline-link"
                onClick={() => void openDoc("terms")}
              >
                Terms &amp; Conditions
              </button>{" "}
              and{" "}
              <button
                type="button"
                className="legal-inline-link"
                onClick={() => void openDoc("privacy")}
              >
                Privacy Policy
              </button>
            </span>
          </label>
        </div>

        {error ? <p className="error">{error}</p> : null}

        <button
          type="button"
          className="legal-continue-btn"
          disabled={!canContinue}
          onClick={() =>
            void onAccept({
              ndaChecked,
              termsPrivacyChecked,
              screenResolution:
                typeof window !== "undefined"
                  ? `${window.screen.width}x${window.screen.height}`
                  : "unknown",
            })
          }
        >
          {busy ? "Recording acceptance…" : "Continue"}
        </button>
      </div>

      <DocModal
        open={modal === "nda"}
        title={ndaMeta.title}
        versionLabel={ndaMeta.versionNumber}
        effectiveDate={ndaMeta.effectiveDate}
        onClose={() => void closeDoc()}
        extraActions={
          <a
            className="nda-btn nda-btn-secondary"
            href={ndaMeta.originalPdfLocation}
            download="Serenity-1-Consulting-NDA.pdf"
          >
            Download Original PDF
          </a>
        }
      >
        <NdaDocumentHtml />
      </DocModal>

      <DocModal
        open={modal === "terms"}
        title={termsMeta.title}
        versionLabel={termsMeta.versionNumber}
        effectiveDate={termsMeta.effectiveDate}
        onClose={() => void closeDoc()}
      >
        <TermsDocumentHtml />
      </DocModal>

      <DocModal
        open={modal === "privacy"}
        title={privacyMeta.title}
        versionLabel={privacyMeta.versionNumber}
        effectiveDate={privacyMeta.effectiveDate}
        onClose={() => void closeDoc()}
      >
        <PrivacyDocumentHtml />
      </DocModal>
    </div>
  );
}
