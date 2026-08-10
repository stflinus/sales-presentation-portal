# Invitation Email Generation — Production Polish

## Status

**DEPLOYED** — Manual ready-to-send invitation email generator on Presentation Created (does not send email).

## What Changed

After a representative creates a presentation, the success screen now generates a complete ready-to-send email using existing client, representative, company, and secure invitation URL data.

No email provider was added. Open in Email / Copy Email / Copy Link do **not** mark the invitation as emailed/sent.

### Success screen

- Title: **Presentation Created ✓**
- Shows Client, Email, Subject (`Your Secure Presentation Is Ready`)
- Shows the full generated email body with the secure URL already inserted
- Actions: **Open in Email**, **Copy Email**, **Copy Link**

### Generated email

- Uses client first name only
- Inserts secure invitation URL automatically
- Signature includes representative name, and optionally title / company / phone / email (omits empty lines — no placeholders)
- Does not mention one-time viewing, security controls, Firebase, Presentation Hub product branding, or legal workflow internals

### Failure handling

If mailto cannot open (or the encoded message is too long), the invitation is unaffected and the UI offers Copy Email / Copy Link.

## Files Changed

- `src/modules/invites/invitationEmail.ts` (new)
- `src/modules/invites/PresentationCreatedDialog.tsx`
- `src/modules/invites/InviteClientForm.tsx`
- `src/styles/global.css`
- `functions/src/callables/createInvite.ts` (returns optional rep title/phone/email; still `emailSent: false`)
- `packages/shared/src/models.ts` (optional `UserProfile.title` / `phone`)
- `tests/unit/invitationMailto.test.ts`
- `docs/reports/FirebaseDeployment.md`

## Tests Performed

Unit tests (`invitationMailto.test.ts`):

1. Client first + last name → first name only
2. Client first name only
3. Representative with all contact fields
4. Missing title / phone / email → lines omitted (no blank labels)
5. Empty company → company line omitted
6. Long invitation URL retained in body and mailto
7. Copy Email payload = Subject + blank line + body
8. Mailto populates TO, exact subject, complete body with URL
9. No internal/security phrases in body

Also verified createInvite still returns `emailSent: false` and does not set `sentAt` when opening/copying email from the UI.

## Remaining Issues

- Representative `title` / `phone` appear in the email only when present on the staff user profile document; there is no new profile-edit UI in this change.
- Some mobile OS / browser mailto length limits may still force the Copy Email fallback for very long URLs — by design.
- Automated email delivery (Gmail/SMTP/etc.) remains out of scope for V0.1.
