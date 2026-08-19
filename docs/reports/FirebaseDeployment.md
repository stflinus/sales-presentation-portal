# Per-User Presentation Video & Access Policy

## Status

**DEPLOYED** — https://presentationhub.web.app

Platform owners/administrators configure per-representative presentation video and access policy from **Admin → Users → Presentation Access**. New invitations snapshot settings; existing invitations are unaffected.

---

## Correction (Aug 17, 2026)

The initial deployment included backend support but the Users UI was gated incorrectly and not reliably visible. This correction:

1. Introduced dedicated permission `presentation_policies:manage` (platform owner/administrator roles only).
2. Fixed UI gating to use that permission instead of generic `users:manage`.
3. Fixed representative row detection — controls show for **representative** and **manager** roles (not blocked by missing optional fields).
4. Added visible **Presentation Access** action button, modal editor, and compact **Presentation** column.
5. Updated `syncClaims` to union role permissions with stored permissions so new platform permissions propagate on sign-in.
6. Deployed hosting + functions to production.

**Platform owner action required once:** Sign out and sign back in so `syncClaims` refreshes JWT with `presentation_policies:manage`.

---

## Architecture

| Area | Behavior |
|------|----------|
| **User profile** | Optional `presentationSettings` on `users/{uid}` |
| **Video selection** | `resolveInvitationPolicy` — user settings or company default |
| **Invitation snapshot** | `videoId`, `accessPolicy`, `accessDurationDays`, `expiresAt`, `policyAppliedAt`, `viewingEntitlementConsumed` |
| **Authorization** | `presentation_policies:manage` — owner/administrator roles only; server-enforced on callables |
| **Firestore rules** | `users` writes blocked (`allow write: if false`) — policy changes via Cloud Functions only |

---

## Access Policies

| Policy | Behavior |
|--------|----------|
| **Single Viewing** | Existing one-time viewing (default / backward compatible) |
| **Time-Limited Access** | Replay until `expiresAt`; completion does not consume entitlement |
| **Single View + Expiration** | One successful view OR expires after N days if unused |

Generic client denial: *"This presentation is no longer available. Please contact your representative for assistance."*

Invalid/deactivated assigned video blocks **new** invite creation with: *"Your presentation configuration requires administrator attention. Please contact your administrator."* (admin audit log retains detail).

---

## Admin UI — Users Page

Each representative/manager row shows:

- **Presentation** column: video title + access summary (compact; responsive on tablet/mobile)
- **Presentation Access** button → modal with:
  - Assigned video (active Video Library dropdown)
  - Access policy (Single Viewing / Time-Limited Access / Single View + Expiration)
  - Duration days when applicable
  - Cancel / Save Changes

Representatives and managers cannot see or modify these controls.

---

## Key Files

- `packages/shared/src/permissions.ts` — `PRESENTATION_POLICIES_MANAGE`
- `packages/shared/src/accessPolicy.ts` — policy types & validation
- `functions/src/lib/presentationPolicy.ts` — resolve, validate, enforce
- `functions/src/callables/manageUsers.ts` — get/update presentation settings callables
- `functions/src/callables/createInvite.ts` — policy snapshot at creation
- `functions/src/lib/authz.ts` — `syncClaims` permission union
- `src/modules/admin/UsersPage.tsx` — Presentation Access UI

---

## Tests

- **73 unit tests passing** (`npm test`)
- New: platform permission granted only to owner/administrator roles
- Policy normalization, duration validation, session enforcement, snapshot immutability

---

## Deployment

```
npm run deploy:all
```

Hosting bundle verified live: `assets/index-CdiGJt0W.js` contains `Presentation Access` and `presentation_policies:manage`.

---

## Verification Checklist

| Item | Status |
|------|--------|
| Presentation Access UI in production bundle | PASS |
| Platform-owner permission RBAC | PASS |
| Server-side callable enforcement | PASS |
| Invitation policy snapshot | PASS |
| Backward compatibility (no migration) | PASS |
| Full interactive E2E (login as owner → configure Dan → create invite) | Requires owner re-login + manual QA |

---

## Remaining Concerns

- Platform owner must **re-login once** after deploy to receive `presentation_policies:manage` in JWT claims.
- App Check not enabled (pre-existing warning).
- Manual end-to-end verification of time-limited replay and single-view paths recommended after configuring a test representative.
