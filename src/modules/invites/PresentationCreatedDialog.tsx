import { useState } from "react";
import {
  INVITATION_EMAIL_SUBJECT,
  buildInvitationEmailBody,
  buildInvitationEmailCopyText,
  buildInvitationMailto,
} from "./invitationEmail";

export interface PresentationCreatedInfo {
  sessionId: string;
  clientName: string;
  clientEmail: string;
  companyName: string;
  representativeName: string;
  representativeTitle?: string | null;
  representativePhone?: string | null;
  representativeEmail?: string | null;
  inviteUrl: string;
}

interface PresentationCreatedDialogProps {
  info: PresentationCreatedInfo;
  onClose: () => void;
}

/**
 * Version 0.1 — manual invitation workflow after Presentation creation.
 * Generates a ready-to-send email; does not send or mark as emailed.
 */
export function PresentationCreatedDialog({
  info,
  onClose,
}: PresentationCreatedDialogProps) {
  const [linkCopied, setLinkCopied] = useState(false);
  const [emailCopied, setEmailCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [mailtoFailed, setMailtoFailed] = useState(false);

  const emailFields = {
    clientName: info.clientName,
    clientEmail: info.clientEmail,
    inviteUrl: info.inviteUrl,
    companyName: info.companyName,
    representativeName: info.representativeName,
    representativeTitle: info.representativeTitle,
    representativePhone: info.representativePhone,
    representativeEmail: info.representativeEmail,
  };

  const emailBody = buildInvitationEmailBody(emailFields);

  async function copyLink() {
    setCopyError(null);
    setEmailCopied(false);
    setMailtoFailed(false);
    try {
      await navigator.clipboard.writeText(info.inviteUrl);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 2500);
    } catch {
      setCopyError("Unable to copy. Select the link and copy manually.");
    }
  }

  async function copyEmail() {
    setCopyError(null);
    setLinkCopied(false);
    setMailtoFailed(false);
    try {
      await navigator.clipboard.writeText(
        buildInvitationEmailCopyText(emailFields),
      );
      setEmailCopied(true);
      window.setTimeout(() => setEmailCopied(false), 2500);
    } catch {
      setCopyError("Unable to copy the email. Please select the text and copy manually.");
    }
  }

  function openEmail() {
    setCopyError(null);
    setMailtoFailed(false);
    try {
      const href = buildInvitationMailto(emailFields);
      // Very long mailto bodies can fail silently on some platforms.
      if (href.length > 2000) {
        setMailtoFailed(true);
        return;
      }
      window.location.href = href;
    } catch {
      setMailtoFailed(true);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="panel modal-panel presentation-created-modal">
        <h2>Presentation Created ✓</h2>

        <dl className="meta-list">
          <div>
            <dt>Client</dt>
            <dd>{info.clientName}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{info.clientEmail}</dd>
          </div>
          <div>
            <dt>Subject</dt>
            <dd>{INVITATION_EMAIL_SUBJECT}</dd>
          </div>
        </dl>

        <div className="invite-email-preview">
          <p className="eyebrow">Generated email</p>
          <pre className="invite-email-body" tabIndex={0}>
            {emailBody}
          </pre>
        </div>

        {emailCopied ? <p className="success">Email copied</p> : null}
        {linkCopied ? <p className="success">Link copied</p> : null}
        {copyError ? <p className="error">{copyError}</p> : null}

        {mailtoFailed ? (
          <div className="invite-mailto-fallback" role="alert">
            <p>Unable to open your email application.</p>
            <p>You can copy the email instead.</p>
            <div className="topbar-actions invite-created-actions">
              <button type="button" onClick={() => void copyEmail()}>
                Copy Email
              </button>
              <button type="button" className="ghost" onClick={() => void copyLink()}>
                Copy Link
              </button>
            </div>
          </div>
        ) : (
          <div className="topbar-actions invite-created-actions">
            <button type="button" onClick={openEmail}>
              Open in Email
            </button>
            <button type="button" className="ghost" onClick={() => void copyEmail()}>
              Copy Email
            </button>
            <button type="button" className="ghost" onClick={() => void copyLink()}>
              Copy Link
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** @deprecated Prefer buildInvitationMailto from invitationEmail.ts */
export { buildInvitationMailto } from "./invitationEmail";
