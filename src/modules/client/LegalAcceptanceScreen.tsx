import { useEffect, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import type { LegalDocType } from "@spp/shared";
import { functions } from "@/lib/firebase";
import { NdaDocumentHtml } from "@/modules/legal/nda/NdaDocumentHtml";
import { getActiveNdaVersion } from "@/modules/legal/nda/versions";
import { TermsDocumentHtml } from "@/modules/legal/terms/TermsDocumentHtml";
import { getActiveTermsVersion } from "@/modules/legal/terms/versions";
import "@/modules/legal/nda/nda.css";
import "./legalAcceptance.css";

type Step = "nda" | "terms" | "complete";

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

export function LegalAcceptanceScreen({
  sessionId,
  busy,
  error,
  onAccept,
}: LegalAcceptanceScreenProps) {
  const [step, setStep] = useState<Step>("nda");
  const [ndaChecked, setNdaChecked] = useState(false);
  const [termsChecked, setTermsChecked] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const ndaMeta = getActiveNdaVersion();
  const termsMeta = getActiveTermsVersion();

  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [step]);

  async function recordView(type: LegalDocType) {
    try {
      const callable = httpsCallable(functions, "recordLegalDocumentView");
      await callable({
        sessionId,
        documentType: type,
        action: "open",
      });
    } catch {
      // Informational only
    }
  }

  function onNdaNext() {
    if (!ndaChecked) return;
    void recordView("nda");
    setStep("terms");
  }

  function onTermsNext() {
    if (!termsChecked) return;
    void recordView("terms");
    void onAccept({
      ndaChecked,
      termsPrivacyChecked: termsChecked,
      screenResolution:
        typeof window !== "undefined"
          ? `${window.screen.width}x${window.screen.height}`
          : "unknown",
    });
  }

  if (step === "nda") {
    return (
      <div className="client-shell legal-flow">
        <div className="legal-flow-step-indicator">
          <span className="legal-flow-dot active" />
          <span className="legal-flow-dot" />
        </div>
        <div className="panel client-panel legal-flow-panel">
          <header className="legal-flow-header">
            <p className="eyebrow">Step 1 of 2</p>
            <h1>{ndaMeta.title}</h1>
            <p className="muted small">
              Version {ndaMeta.versionNumber}
              {ndaMeta.effectiveDate ? ` · Effective ${ndaMeta.effectiveDate}` : ""}
            </p>
          </header>

          <div className="legal-flow-document" ref={scrollRef}>
            <NdaDocumentHtml />
          </div>

          <div className="legal-flow-accept">
            <label className="legal-flow-checkbox">
              <input
                type="checkbox"
                checked={ndaChecked}
                onChange={(e) => setNdaChecked(e.target.checked)}
              />
              <span>I have read and agree to the Non-Disclosure Agreement</span>
            </label>

            {error ? <p className="error">{error}</p> : null}

            <button
              type="button"
              className="legal-flow-btn"
              disabled={!ndaChecked || busy}
              onClick={onNdaNext}
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === "terms") {
    return (
      <div className="client-shell legal-flow">
        <div className="legal-flow-step-indicator">
          <span className="legal-flow-dot completed" />
          <span className="legal-flow-dot active" />
        </div>
        <div className="panel client-panel legal-flow-panel">
          <header className="legal-flow-header">
            <p className="eyebrow">Step 2 of 2</p>
            <h1>{termsMeta.title}</h1>
            <p className="muted small">
              Version {termsMeta.versionNumber}
              {termsMeta.effectiveDate ? ` · Effective ${termsMeta.effectiveDate}` : ""}
            </p>
          </header>

          <div className="legal-flow-document" ref={scrollRef}>
            <TermsDocumentHtml />
          </div>

          <div className="legal-flow-accept">
            <label className="legal-flow-checkbox">
              <input
                type="checkbox"
                checked={termsChecked}
                onChange={(e) => setTermsChecked(e.target.checked)}
              />
              <span>I have read and agree to the Terms &amp; Conditions</span>
            </label>

            {error ? <p className="error">{error}</p> : null}

            <button
              type="button"
              className="legal-flow-btn"
              disabled={!termsChecked || busy}
              onClick={onTermsNext}
            >
              {busy ? "Recording acceptance…" : "Continue to Presentation"}
            </button>

            <button
              type="button"
              className="legal-flow-back"
              disabled={busy}
              onClick={() => setStep("nda")}
            >
              ← Back to NDA
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
