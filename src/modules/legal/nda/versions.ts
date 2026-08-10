/**
 * NDA version registry — source of truth for public /legal/nda metadata.
 * Original PDF bytes are immutable under public/legal/nda/<version>/…
 * Future versions append new entries; never mutate prior entries or PDF files.
 */
export type NdaVersionStatus = "draft" | "active" | "archived";

export interface NdaVersionRecord {
  documentType: "nda";
  versionNumber: string;
  effectiveDate: string; // YYYY-MM-DD
  status: NdaVersionStatus;
  createdDate: string; // YYYY-MM-DD
  createdBy: string;
  active: boolean;
  previousVersion: string | null;
  originalPdfLocation: string;
  title: string;
  pdfSha256: string;
}

/** Chronological registry; last active entry is current when multiple exist. */
export const NDA_VERSIONS: readonly NdaVersionRecord[] = [
  {
    documentType: "nda",
    versionNumber: "1.0.0",
    effectiveDate: "2026-06-13",
    status: "active",
    createdDate: "2026-08-03",
    createdBy: "dovekai9@gmail.com",
    active: true,
    previousVersion: null,
    originalPdfLocation: "/legal/nda/v1.0.0/Serenity-1-Consulting-NDA.pdf",
    title: "NON-DISCLOSURE AND LIABILITY WAIVER AGREEMENT",
    pdfSha256:
      "2dbdbb2c50ac6e2d741b1b9e716d5bafeab9130383793021c3c531cb601d3fb6",
  },
] as const;

export function getActiveNdaVersion(): NdaVersionRecord {
  const active = [...NDA_VERSIONS].reverse().find((v) => v.active);
  if (!active) {
    throw new Error("No active NDA version configured.");
  }
  return active;
}

/**
 * Plain-text body for Firestore / future acceptance flows.
 * Wording must match the uploaded PDF (presentation-only differences allowed in HTML).
 */
export const NDA_V1_PLAIN_TEXT = `Welcome to our informational seminar about some very exciting new programs we have to offer. We are very pleased to let you know that over the past several years, we have been able to successfully help clients obtain refunds related to their timeshare ownership. Once the attached NDA has been signed, we will begin and provide you with all of the information you came today to hear.

Before we begin, there are a few things to cover to ensure we are being respectful of your time.

1st. It is okay to be skeptical; you don't have any information yet

2nd. You are not required to exit your timeshare to receive any refunds, credits, or compensation you may be entitled to. If you enjoy your ownership, that is perfectly fine. If you qualify, this will not negatively impact your ownership.

3rd. Not everyone will qualify. We can only present what we know at this stage, and we will need additional information to determine what, if anything, you may qualify for. We reached out to you because we believe you may qualify; however, this is not a guarantee.

4th. You do not have to currently own your timeshare to receive credits or refunds, if you qualify.

5th. If you exited your timeshare more than five years ago, you will not qualify, and there is no reason for you to be here today.

6th. If you would like to end your ownership or explore other travel options, please let us know and we can discuss those options with you at another time; however, that is not the purpose of today's presentation.

Please complete the attached form and sign the NDA so we can share this exciting information with you.

NON-DISCLOSURE AND LIABILITY WAIVER AGREEMENT

This Non-Disclosure and Liability Waiver Agreement ("Agreement") is entered into between the undersigned Client ("Client") and Timeshare Education Council (TEC), Apricorn LLC, Serenity 1 LLC, and Resorts & Cruises LLC (collectively referred to as "the Companies").

1. Purpose
The purpose of this Agreement is to protect the confidentiality and proprietary nature of all information disclosed by the Companies to the Client, whether verbally, electronically, or in writing, during or after any meeting, seminar, consultation, or service engagement.

2. Confidential Information
For the purpose of this Agreement, "Confidential Information" includes but is not limited to:
- Internal business methods, strategies, processes, and materials not publicly available.
- Settlement details, negotiated terms, and amounts of money received, recovered, or credited.
- Tax evaluations, tax credits, or financial assessments.
- Client lists, templates, training materials, communications, or any proprietary systems.
- Any recordings, photographs, or other digital media related to the Companies' operations, staff, or clients.

All such information is proprietary and protected under applicable laws.

3. Non-Disclosure Obligations
The Client agrees that:
- They shall not, under any circumstances, disclose, copy, share, or discuss any Confidential Information with any third party without prior written consent from an authorized representative of the Companies.
- Confidential Information shall not be used for any personal, commercial, or competitive purpose.
- This prohibition includes, but is not limited to, disclosure through social media, public forums, emails, or digital communications.

Any violation of this provision will constitute a material breach of this Agreement.

4. Duration
This Agreement and all confidentiality obligations shall remain in effect indefinitely, surviving the completion, termination, or expiration of any service relationship with the Companies.

5. Recordings and Media Disclaimer
The Client understands and agrees that:
- Any unauthorized audio, video, or digital recording, including surreptitious recordings, are strictly prohibited.
- No recording or digital media of any meeting, event, or seminar may be shared, posted, or distributed publicly.
- The likeness, image, or voice of any person associated with or present during the Companies' activities is not released for public use.
- Any person whose likeness, image, or voice is used or disclosed without consent may pursue legal action against the offending party.

6. Liability Waiver
The Client releases and holds harmless the Companies, their officers, employees, and affiliates from any claims, damages, or liabilities arising out of participation in consultations, educational programs, or related activities, except in cases of proven gross negligence or intentional misconduct.

7. Breach and Legal Action
The Client understands and agrees that:
- Legal action will be taken in the event of any breach of this Agreement.
- The Companies are entitled to seek injunctive relief, damages, and recovery of attorney's fees and court costs for enforcement of this Agreement.

8. Client Acknowledgement
By signing below, the Client acknowledges that they have read, understand, and agree to be bound by the terms of this Non-Disclosure and Liability Waiver Agreement in its entirety.

Client Name:
Signature:
Date:

Client Name:
Signature:
Date:

Representative (if applicable):
Title:`;
