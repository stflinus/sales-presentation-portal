/**
 * Terms & Conditions version registry.
 * Future versions append new entries; never mutate prior entries.
 */
export type TermsVersionStatus = "draft" | "active" | "archived";

export interface TermsVersionRecord {
  documentType: "terms";
  versionNumber: string;
  effectiveDate: string; // YYYY-MM-DD
  status: TermsVersionStatus;
  createdDate: string;
  createdBy: string;
  active: boolean;
  previousVersion: string | null;
  title: string;
}

export const TERMS_VERSIONS: readonly TermsVersionRecord[] = [
  {
    documentType: "terms",
    versionNumber: "1.0",
    effectiveDate: "2026-08-03",
    status: "active",
    createdDate: "2026-08-03",
    createdBy: "dovekai9@gmail.com",
    active: true,
    previousVersion: null,
    title: "Presentation Hub Terms & Conditions",
  },
] as const;

export function getActiveTermsVersion(): TermsVersionRecord {
  const active = [...TERMS_VERSIONS].reverse().find((v) => v.active);
  if (!active) {
    throw new Error("No active Terms version configured.");
  }
  return active;
}

/**
 * Exact approved Version 1.0 plain-text body for immutable Firestore snapshot.
 * Presentation markup lives only in TermsDocumentHtml — wording here must match.
 */
export const TERMS_V1_PLAIN_TEXT = `Presentation Hub Terms & Conditions

Effective Date: August 3, 2026
Version: 1.0

1. Acceptance of These Terms

These Terms & Conditions govern your access to and use of Presentation Hub, including any presentations, videos, documents, legal notices, communications, and other materials made available through the Platform.

In these Terms, “Platform” means Presentation Hub and its related websites, applications, systems, and services. “Inviting Organization” means the company or organization whose authorized representative provided your invitation.

By accessing the Platform, opening an invitation, checking an acceptance box, or continuing to a presentation, you acknowledge that you have read, understand, and agree to these Terms & Conditions.

If you do not agree to these Terms, do not continue to use the Platform or access the presentation.

2. Electronic Records and Consent

You consent to receive and review these Terms and other required legal documents electronically.

You agree that checking an acceptance box and selecting the Continue button constitutes your electronic acknowledgment and acceptance to the extent permitted by applicable law.

The Platform may record the version of each document presented to you, the date and time of acceptance, your Internet Protocol address, browser and device information, invitation and session identifiers, and related technical audit information.

You may review the applicable legal documents before accepting them and may print them using the available print function or your browser’s print controls.

3. Purpose of the Platform

Presentation Hub is an invitation-based platform used by authorized organizations and representatives to provide presentations, educational information, confidential materials, and related content to intended recipients.

The Platform may also record whether an invitation was opened, whether required legal documents were accepted, whether a presentation was started or completed, and whether follow-up activity was scheduled.

Presentation Hub is a technology and presentation-delivery platform. It is not itself the provider of the underlying products, programs, consulting services, financial services, tax services, legal services, or other services described in a presentation unless expressly stated otherwise.

4. Invitation-Only Access

Access to a presentation is limited to its intended recipient.

You agree that you will not:

- Share your invitation link or access token with another person.
- Permit another person to access a presentation using your invitation.
- Attempt to access another person’s invitation, account, session, or records.
- Modify, guess, reproduce, or manipulate an invitation token or URL.
- Circumvent authentication, access controls, viewing restrictions, or security measures.

If you receive an invitation that was not intended for you, you must not use it and should notify the representative or organization that sent it.

5. Accuracy of Information

You agree to provide accurate information when requested through the Platform.

This may include your name, email address, and other information necessary to identify the intended recipient, document legal acceptance, provide access, or support authorized follow-up.

You must not knowingly submit false, misleading, fraudulent, or impersonated information.

6. Confidential and Proprietary Materials

Presentations and related materials may contain confidential, proprietary, commercially sensitive, or legally protected information belonging to the Inviting Organization or other identified parties.

Your confidentiality obligations are governed by the Non-Disclosure Agreement presented separately through the Platform.

Nothing in these Terms reduces, replaces, limits, or supersedes any obligation contained in that Non-Disclosure Agreement.

If there is a conflict between these Terms and the Non-Disclosure Agreement regarding confidential information, the Non-Disclosure Agreement controls with respect to that confidential information.

7. Recording and Reproduction Restrictions

Unless you receive prior written permission from an authorized representative of the applicable rights holder, you may not:

- Make an audio, video, photographic, screen, or digital recording of a presentation.
- Take screenshots or screen captures of confidential presentation materials.
- Download, copy, reproduce, transcribe, publish, distribute, or transmit presentation content.
- Use screen-recording software, external recording devices, cameras, or similar methods to preserve presentation content.
- Share presentation content through email, text message, social media, cloud storage, public forums, private groups, or any other communication channel.

Technical controls may be used to discourage unauthorized recording or reproduction. You acknowledge that such controls do not replace your contractual responsibilities.

8. One-Time and Limited Viewing

Certain presentations may be limited to one authorized viewing.

A presentation may be treated as completed and permanently consumed when the Platform records successful completion under its configured completion requirements.

After completion:

- Access may be permanently closed.
- The invitation may no longer permit playback.
- Signed media links may no longer be issued or renewed.
- A new invitation may be required for any additional authorized viewing.

Opening an invitation, accepting legal documents, or loading the presentation page does not necessarily constitute completion.

If a technical interruption occurs before completion, access may be resumed or reset when permitted by the Platform and the Inviting Organization.

You may not attempt to bypass or defeat a one-time viewing restriction.

9. No Guarantee of Qualification or Results

Information presented through the Platform may describe programs, services, opportunities, evaluations, credits, refunds, compensation, settlements, financial strategies, travel options, ownership options, or other potential outcomes.

Access to a presentation does not guarantee that you:

- Qualify for any program or service.
- Will receive any refund, credit, compensation, settlement, benefit, or particular result.
- Will be accepted as a client.
- Will receive identical results to another person.
- Will be offered any particular terms.

Eligibility and potential outcomes may depend on additional information, documentation, review, verification, agreements, third-party decisions, applicable law, and individual circumstances.

Statements regarding possible results must not be interpreted as promises or guarantees unless expressly included in a separate signed agreement.

10. Informational Nature of Presentation Content

Unless expressly stated in a separate written agreement, presentation content is provided for informational and educational purposes.

Nothing presented through the Platform should automatically be treated as individualized legal, tax, accounting, investment, financial, credit, or other regulated professional advice.

You should consult an appropriately qualified professional regarding decisions requiring professional advice.

Presentation Hub does not independently verify every statement made by an Inviting Organization and does not assume responsibility for the Inviting Organization’s products, services, representations, or business practices.

11. No Purchase Requirement Through the Platform

Presentation Hub is used to deliver information and document client activity.

Unless expressly shown and agreed through a separate transaction or contract, accepting these Terms, accepting the Non-Disclosure Agreement, accepting the Privacy Policy, or watching a presentation does not itself require you to purchase a product or service.

Any future purchase, engagement, enrollment, or service relationship must be governed by its own applicable agreement.

12. Acceptable Use

You may use the Platform only for lawful purposes and only as authorized by your invitation.

You may not:

- Interfere with or disrupt the Platform.
- Probe, scan, or test the vulnerability of the Platform without written authorization.
- Attempt to access administrative tools or restricted data.
- Upload malicious software or harmful code.
- Automate requests in a way that interferes with normal operation.
- Reverse engineer or attempt to discover protected source code, tokens, security controls, or internal systems.
- Use the Platform to violate another person’s rights.
- Use information obtained through the Platform for fraud, harassment, unlawful competition, or another unauthorized purpose.

13. Intellectual Property

The Platform, its software, interface, design, workflows, branding, and related technology are protected by applicable intellectual-property laws.

Presentation videos, documents, graphics, scripts, trademarks, service marks, business methods, and other materials remain the property of their respective owners.

Your access does not transfer ownership or grant you a license to copy, reproduce, publish, distribute, modify, create derivative works from, sell, sublicense, or commercially exploit any protected material.

You receive only a limited, temporary, revocable right to access the specific content authorized by your invitation.

14. Audit and Security Records

To protect the Platform, enforce access restrictions, document legal acceptance, support compliance, and resolve disputes, the Platform may create and retain audit and security records.

These records may include:

- Client name and email address.
- Representative and Inviting Organization identifiers.
- Invitation and session identifiers.
- Date and time of invitation, access, acceptance, playback, and completion.
- Document titles, versions, effective dates, and cryptographic hashes.
- Internet Protocol address.
- User agent.
- Browser, operating system, and device information.
- Screen-resolution information when available.
- Viewing progress and completion status.
- Access denials, security events, and session activity.
- Notes and follow-up information entered by authorized representatives.

Audit records may be designed to prevent unauthorized modification or deletion.

Your use of the Platform constitutes acknowledgment that these records may be created and retained as described in the Privacy Policy.

15. Privacy

The collection and handling of personal information through the Platform are described in the Presentation Hub Privacy Policy presented separately.

The Privacy Policy is incorporated into these Terms by reference.

You must review and accept the Privacy Policy before continuing to a restricted presentation.

16. Third-Party Services

The Platform may rely on third-party infrastructure and service providers for hosting, authentication, databases, file storage, email delivery, analytics, security, and related technical functions.

Presentation Hub is not responsible for an interruption, outage, delay, or failure caused by a third-party provider beyond its reasonable control.

Links to third-party websites or services do not constitute an endorsement or guarantee of those third parties.

Your use of a third-party product or service may be subject to separate terms and privacy policies.

17. Platform Availability

The Platform is provided on an “as available” basis.

Reasonable efforts may be made to maintain reliable access, but uninterrupted or error-free operation is not guaranteed.

Access may be limited, delayed, suspended, or unavailable because of:

- Maintenance.
- Updates.
- Security events.
- Network or service-provider outages.
- Equipment or software failures.
- Legal or regulatory requirements.
- Events beyond reasonable control.

18. Suspension or Termination of Access

Access may be suspended, revoked, or terminated if:

- The invitation expires or is revoked.
- The presentation has been completed.
- Unauthorized access or sharing is suspected.
- You violate these Terms or the Non-Disclosure Agreement.
- Continued access may threaten security, confidentiality, legal compliance, or system operation.
- The Inviting Organization withdraws authorization.

Suspension or termination does not eliminate obligations that are intended to survive, including confidentiality, intellectual-property, audit, and enforcement provisions.

19. Disclaimer of Warranties

To the maximum extent permitted by applicable law, the Platform is provided without warranties of uninterrupted availability, error-free operation, fitness for a particular purpose, or compatibility with every device, browser, or network.

Nothing in this section excludes a warranty or right that cannot lawfully be excluded.

The Inviting Organization remains responsible for any warranties expressly provided in a separate written agreement concerning its own products or services.

20. Limitation of Liability

To the maximum extent permitted by applicable law, Presentation Hub, its operators, technology providers, officers, employees, contractors, and affiliates will not be liable for indirect, incidental, special, exemplary, punitive, or consequential damages arising solely from use of or inability to use the Platform.

This limitation does not apply where liability cannot lawfully be limited or excluded.

Nothing in these Terms limits obligations created by a separate written agreement between you and the Inviting Organization.

21. Honest Reviews and Lawful Communications

Nothing in these Terms prohibits you from submitting an honest review, reporting suspected unlawful conduct, communicating with a government agency, responding to lawful legal process, or exercising another right that cannot legally be waived.

However, you remain responsible for complying with valid confidentiality obligations and may not disclose protected trade secrets, confidential materials, private client information, or presentation content except where disclosure is authorized or legally protected.

22. Governing Law

These Terms are governed by the laws of the State of Missouri, without regard to conflict-of-law principles, except where another jurisdiction’s law must apply.

Any dispute concerning use of the Platform shall be brought in a court of competent jurisdiction, subject to applicable law and any separate enforceable agreement between you and the Inviting Organization.

23. Changes and Versioning

These Terms may be updated periodically.

Each published version will have a version number and effective date.

The Platform will preserve the version presented and accepted for each applicable client session.

A later version will not retroactively replace the version previously accepted for an earlier session.

You may be required to accept an updated version before accessing a future presentation.

24. Severability

If any provision of these Terms is found invalid or unenforceable, the remaining provisions will continue in effect to the fullest extent permitted by law.

25. No Waiver

Failure to enforce a provision of these Terms does not waive the right to enforce that provision or another provision later.

26. Entire Agreement Regarding Platform Use

These Terms, the Privacy Policy, the applicable Non-Disclosure Agreement, and any additional documents expressly presented for acceptance constitute the agreement governing your use of the Platform.

They do not replace a separate service, purchase, consulting, engagement, or other agreement between you and an Inviting Organization.

27. Contact

Questions about these Terms, the presentation, or the Inviting Organization should be directed to the representative or organization that provided your invitation.

Technical questions regarding access to the Platform may also be directed through the contact method provided with your invitation.`;
