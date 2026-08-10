/**
 * Privacy Policy version registry.
 * Future versions append new entries; never mutate prior entries.
 */
export type PrivacyVersionStatus = "draft" | "active" | "archived";

export interface PrivacyVersionRecord {
  documentType: "privacy";
  versionNumber: string;
  effectiveDate: string;
  status: PrivacyVersionStatus;
  createdDate: string;
  createdBy: string;
  active: boolean;
  previousVersion: string | null;
  title: string;
}

export const PRIVACY_VERSIONS: readonly PrivacyVersionRecord[] = [
  {
    documentType: "privacy",
    versionNumber: "1.0",
    effectiveDate: "2026-08-03",
    status: "active",
    createdDate: "2026-08-03",
    createdBy: "dovekai9@gmail.com",
    active: true,
    previousVersion: null,
    title: "Presentation Hub Privacy Policy",
  },
] as const;

export function getActivePrivacyVersion(): PrivacyVersionRecord {
  const active = [...PRIVACY_VERSIONS].reverse().find((v) => v.active);
  if (!active) {
    throw new Error("No active Privacy Policy version configured.");
  }
  return active;
}

/**
 * Exact approved Version 1.0 plain-text body for immutable Firestore snapshot.
 */
export const PRIVACY_V1_PLAIN_TEXT = `Presentation Hub Privacy Policy

Effective Date: August 3, 2026
Version: 1.0

1. Overview

Presentation Hub is designed to securely deliver confidential presentations while maintaining an auditable record of invitation delivery, legal acceptance, presentation viewing, and authorized follow-up activities.

This Privacy Policy explains what information may be collected through the Platform, why it is collected, how it is used, and how it is protected.

Throughout this document, "Platform" refers to Presentation Hub.

"Inviting Organization" refers to the company or representative who invited you to use the Platform.

2. Information We Collect

Depending upon how the Platform is used, we may collect:

- Name
- Email address
- Invitation information
- Representative information
- Company information
- Date and time of invitation
- Date and time of presentation access
- Date and time legal documents were accepted
- Presentation completion status
- Follow-up scheduling information
- Internet Protocol (IP) address
- Browser information
- Operating System
- Device type
- Screen resolution when available
- User Agent
- Session identifiers
- Invitation identifiers
- Audit log events
- Security events

The Platform intentionally limits collection to information reasonably necessary to operate the service, protect confidential information, document legal acceptance, maintain audit records, and support authorized follow-up.

3. Why Information Is Collected

Information is collected to:

- Authenticate invited users.
- Deliver presentations securely.
- Record acceptance of legal documents.
- Protect confidential information.
- Prevent unauthorized access.
- Support one-time viewing restrictions.
- Maintain audit records.
- Assist authorized representatives.
- Schedule client follow-up.
- Improve security and reliability.

4. Legal Acceptance Records

Whenever legal documents are accepted through Presentation Hub, an immutable audit record may be created.

This record may include:

- Document type
- Document version
- Effective date
- Acceptance timestamp
- Invitation identifier
- Session identifier
- Representative identifier
- Company identifier
- Internet Protocol address
- Browser
- Operating System
- Device information
- User Agent
- Cryptographic hash of the accepted document version

These records help demonstrate exactly which version of each legal document was accepted.

5. Presentation Activity

Presentation Hub may record:

- Invitation opened
- Presentation started
- Presentation completed
- Viewing progress
- One-time viewing completion
- Session expiration
- Follow-up scheduling

These records are maintained for operational, security, and auditing purposes.

6. Data Sharing

Presentation Hub does not sell personal information.

Information may be shared only with:

- The Inviting Organization
- Authorized representatives
- Service providers required to operate the Platform
- Government authorities when required by applicable law
- Courts or legal process when required

7. Data Security

Presentation Hub employs administrative, technical, and organizational safeguards intended to protect stored information.

Examples include:

- Authentication
- Authorization
- Encrypted communication
- Audit logging
- Access controls
- Security monitoring

Although reasonable efforts are used, no technology can guarantee absolute security.

8. Data Retention

Information is retained only as long as reasonably necessary to:

- Operate the Platform
- Maintain audit records
- Support legal compliance
- Protect confidential information
- Resolve disputes
- Enforce agreements

Certain legal acceptance records may be retained longer where appropriate for compliance or evidentiary purposes.

9. Your Choices

Subject to applicable law, you may request access to certain personal information held by the Inviting Organization.

Some information may not be deleted where retention is necessary for legal compliance, audit integrity, fraud prevention, or contractual obligations.

10. Cookies and Technical Storage

Presentation Hub may use cookies or similar technologies necessary for:

- Authentication
- Session management
- Security
- Platform functionality

These technologies are not intended to track unrelated browsing activity.

11. Third-Party Services

Presentation Hub relies upon third-party infrastructure providers including hosting, authentication, databases, storage, analytics, and related technical services.

Those providers process information only as necessary to deliver Platform functionality.

12. Future Updates

This Privacy Policy may be updated periodically.

Every published version will include:

- Version Number
- Effective Date

The Platform preserves the version accepted during each client session.

Future versions do not replace previously accepted versions.

13. Contact

Questions regarding this Privacy Policy should be directed to the organization that provided your invitation.`;
