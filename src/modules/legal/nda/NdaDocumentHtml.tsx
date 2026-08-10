/**
 * Responsive HTML rendering of NDA v1.0.0.
 * Legal wording matches the uploaded PDF; only presentation markup differs.
 */
export function NdaDocumentHtml() {
  return (
    <article className="nda-document" aria-label="Client Non-Disclosure Agreement">
      <header className="nda-brand" id="preamble">
        <p className="nda-brand-name">Serenity 1</p>
      </header>

      <section className="nda-section" aria-labelledby="nda-intro-heading">
        <h2 id="nda-intro-heading" className="visually-hidden">
          Seminar introduction
        </h2>
        <p>
          Welcome to our informational seminar about some very exciting new
          programs we have to offer. We are very <strong>pleased</strong> to let
          you know that over the past several years, we have been able to
          successfully help clients obtain refunds related to their timeshare
          ownership. Once the attached NDA has been signed, we will{" "}
          <strong>begin</strong> and provide you with all of the information you{" "}
          <strong>came</strong> today to hear.
        </p>
        <p>
          Before we <strong>begin</strong>, there are a few things to cover to
          ensure we are being respectful of your time.
        </p>
        <ol className="nda-ordinal-list">
          <li>
            <strong>1st.</strong> It is okay to be skeptical; you don&apos;t have
            any information yet
          </li>
          <li>
            <strong>2nd.</strong> You are not required to exit your timeshare to
            receive any refunds, credits, or compensation you may be entitled to.
            If you enjoy your ownership, that is perfectly fine. If you qualify,
            this will not negatively impact your ownership.
          </li>
          <li>
            <strong>3rd.</strong> Not everyone will qualify. We can only present
            what we know at this stage, and we will need additional information
            to determine what, if anything, you may qualify for. We reached out
            to you because we believe you <em>may</em> qualify; however, this is
            not a guarantee.
          </li>
          <li>
            <strong>4th.</strong> You do not have to currently own your timeshare
            to receive credits or refunds, if you qualify.
          </li>
          <li>
            <strong>5th.</strong> If you exited your timeshare more than five
            years ago, you will not qualify, and there is no reason for you to be
            here today.
          </li>
          <li>
            <strong>6th.</strong> If you would like to end your ownership or
            explore other travel options, please let us know and we can discuss
            those options with you at another time; however, that is not the
            purpose of today&apos;s presentation.
          </li>
        </ol>
        <p>
          Please complete the attached form and sign the NDA so we can share this
          exciting information with you.
        </p>
      </section>

      <hr className="nda-divider" />

      <h2 className="nda-agreement-title" id="agreement">
        NON-DISCLOSURE AND LIABILITY WAIVER AGREEMENT
      </h2>
      <p>
        This Non-Disclosure and Liability Waiver Agreement (&quot;Agreement&quot;)
        is entered into between the undersigned Client (&quot;Client&quot;) and
        Timeshare Education Council (TEC), Apricorn LLC, Serenity 1 LLC, and
        Resorts &amp; Cruises LLC (collectively referred to as &quot;the
        Companies&quot;).
      </p>

      <section className="nda-section" id="section-1" aria-labelledby="h-purpose">
        <h3 id="h-purpose">1. Purpose</h3>
        <p>
          The purpose of this Agreement is to protect the confidentiality and
          proprietary nature of all information disclosed by the Companies to the
          Client, whether verbally, electronically, or in writing, during or
          after any meeting, seminar, consultation, or service engagement.
        </p>
      </section>

      <section
        className="nda-section"
        id="section-2"
        aria-labelledby="h-confidential"
      >
        <h3 id="h-confidential">2. Confidential Information</h3>
        <p>
          For the purpose of this Agreement, &quot;Confidential
          Information&quot; includes but is not limited to:
        </p>
        <ul>
          <li>
            Internal business methods, strategies, processes, and materials not
            publicly available.
          </li>
          <li>
            Settlement details, negotiated terms, and amounts of money received,
            recovered, or credited.
          </li>
          <li>Tax evaluations, tax credits, or financial assessments.</li>
          <li>
            Client lists, templates, training materials, communications, or any
            proprietary systems.
          </li>
          <li>
            Any recordings, photographs, or other digital media related to the
            Companies&apos; operations, staff, or clients.
          </li>
        </ul>
        <p>
          All such information is proprietary and protected under applicable
          laws.
        </p>
      </section>

      <section
        className="nda-section"
        id="section-3"
        aria-labelledby="h-nondisclosure"
      >
        <h3 id="h-nondisclosure">3. Non-Disclosure Obligations</h3>
        <p>The Client agrees that:</p>
        <ul>
          <li>
            They shall not, under any circumstances, disclose, copy, share, or
            discuss any Confidential Information with any third party without
            prior written consent from an authorized representative of the
            Companies.
          </li>
          <li>
            Confidential Information shall not be used for any personal,
            commercial, or competitive purpose.
          </li>
          <li>
            This prohibition includes, but is not limited to, disclosure through
            social media, public forums, emails, or digital communications.
          </li>
        </ul>
        <p>
          Any violation of this provision will constitute a material breach of
          this Agreement.
        </p>
      </section>

      <section className="nda-section" id="section-4" aria-labelledby="h-duration">
        <h3 id="h-duration">4. Duration</h3>
        <p>
          This Agreement and all confidentiality obligations shall remain in
          effect indefinitely, surviving the completion, termination, or
          expiration of any service relationship with the Companies.
        </p>
      </section>

      <section className="nda-section" id="section-5" aria-labelledby="h-media">
        <h3 id="h-media">5. Recordings and Media Disclaimer</h3>
        <p>The Client understands and agrees that:</p>
        <ul>
          <li>
            Any unauthorized audio, video, or digital recording, including
            surreptitious recordings, are strictly prohibited.
          </li>
          <li>
            No recording or digital media of any meeting, event, or seminar may
            be shared, posted, or distributed publicly.
          </li>
          <li>
            The likeness, image, or voice of any person associated with or
            present during the Companies&apos; activities is not released for
            public use.
          </li>
          <li>
            Any person whose likeness, image, or voice is used or disclosed
            without consent may pursue legal action against the offending party.
          </li>
        </ul>
      </section>

      <section className="nda-section" id="section-6" aria-labelledby="h-liability">
        <h3 id="h-liability">6. Liability Waiver</h3>
        <p>
          The Client releases and holds harmless the Companies, their officers,
          employees, and affiliates from any claims, damages, or liabilities
          arising out of participation in consultations, educational programs, or
          related activities, except in cases of proven gross negligence or
          intentional misconduct.
        </p>
      </section>

      <section className="nda-section" id="section-7" aria-labelledby="h-breach">
        <h3 id="h-breach">7. Breach and Legal Action</h3>
        <p>The Client understands and agrees that:</p>
        <ul>
          <li>
            Legal action will be taken in the event of any breach of this
            Agreement.
          </li>
          <li>
            The Companies are entitled to seek injunctive relief, damages, and
            recovery of attorney&apos;s fees and court costs for enforcement of
            this Agreement.
          </li>
        </ul>
      </section>

      <section
        className="nda-section"
        id="section-8"
        aria-labelledby="h-acknowledgement"
      >
        <h3 id="h-acknowledgement">8. Client Acknowledgement</h3>
        <p>
          By signing below, the Client acknowledges that they have read,
          understand, and agree to be bound by the terms of this Non-Disclosure
          and Liability Waiver Agreement in its entirety.
        </p>
      </section>

      <section className="nda-signatures" aria-label="Signature blocks">
        <div className="nda-sign-block">
          <p>Client Name: <span className="nda-line" /></p>
          <p>Signature: <span className="nda-line" /></p>
          <p>Date: <span className="nda-line nda-line-short" /></p>
        </div>
        <div className="nda-sign-block">
          <p>Client Name: <span className="nda-line" /></p>
          <p>Signature: <span className="nda-line" /></p>
          <p>Date: <span className="nda-line nda-line-short" /></p>
        </div>
        <div className="nda-sign-block">
          <p>
            Representative (if applicable): <span className="nda-line" />
          </p>
          <p>Title: <span className="nda-line" /></p>
        </div>
      </section>
    </article>
  );
}
