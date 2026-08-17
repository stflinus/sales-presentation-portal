# Per-User Presentation Video & Access Policy

## Status

**DEPLOYED** — https://presentationhub.web.app

Platform administrators can configure per-staff presentation video and access policy. New invitations snapshot these settings; existing invitations are unaffected.

---

## Architecture Discovered (pre-change)

| Area | Existing behavior |
|------|-------------------|
| **User profile** | `users/{uid}` — email, role, company; no presentation settings |
| **Video selection** | `createInvite` used `getActiveVideoForCompany(companyId)` from company `activeVideoId` |
| **Expiration** | `company.defaultInviteTtlHours` (default 168h) on invite + session at creation |
| **One-time viewing** | `viewingLeases`, `finalizeCompletion` — disables auth, marks lease consumed, sets `viewingEntitlementConsumed` |
| **Admin users** | `UsersPage` / `manageUsers` callables — staff CRUD only |
| **Legal evidence** | Independent immutable records; not tied to operational policy changes |
| **Activity/Health** | Presentation activity log with admin diagnostics |

---

## Schema Changes

### User profile (`users/{uid}`)

Optional field:

```typescript
presentationSettings?: {
  activeVideoId?: string | null;   // null → company default video
  accessPolicy?: AccessPolicy;     // default: single_view
  accessDurationDays?: number | null; // 1–365, default 7 when policy needs days
}
```

No migration required. Users without this field retain company-default video + single-view + company TTL.

### Invite + session snapshot (at creation)

Both `invites/{id}` and `presentationSessions/{id}` store:

| Field | Purpose |
|-------|---------|
| `videoId` | Snapshotted video (already existed) |
| `accessPolicy` | `single_view` \| `time_limited` \| `single_view_with_expiration` |
| `accessDurationDays` | Days for time-limited policies (null for pure single-view) |
| `expiresAt` | Computed deadline (company TTL for single-view; days × 24h for others) |
| `policyAppliedAt` | ISO timestamp when policy was snapshotted |
| `viewingEntitlementConsumed` | Boolean; set true after successful single-view completion |

Existing records without `accessPolicy` are treated as `single_view` (backward compatible).

---

## Access Policies

| Policy | Behavior |
|--------|----------|
| **Single Viewing** (`single_view`) | Existing production behavior preserved. One successful viewing; failed loads do not consume entitlement. |
| **Available for a Set Period** (`time_limited`) | Replay allowed while `now < expiresAt`. Completion does not consume entitlement or disable auth. Legal acceptance not re-required on reopen. |
| **Single View + Expiration** (`single_view_with_expiration`) | Single-view rules AND expires after N days if unused. Whichever blocks first wins. |

Client-facing denial message (generic):

> This presentation is no longer available. Please contact your representative for assistance.

Internal policy details are never shown to clients.

---

## Implementation

### Shared types

- `packages/shared/src/accessPolicy.ts` — policy constants, validation, admin labels
- `packages/shared/src/models.ts` — `UserProfile.presentationSettings`, invite/session snapshot fields
- `packages/shared/src/activity.ts` — `PRESENTATION_POLICY_APPLIED`, `PRESENTATION_REOPENED`, `VIEWING_ENTITLEMENT_CONSUMED`, `ACCESS_DENIED`

### Backend

- `functions/src/lib/presentationPolicy.ts` — `resolveInvitationPolicy`, admin validation, video listing
- `functions/src/lib/presentationPolicy.pure.ts` — pure session access helpers (testable)
- `functions/src/callables/createInvite.ts` — resolves user policy, snapshots onto invite + session
- `functions/src/callables/exchangeInvite.ts` — policy-aware expired/consumed checks; TIME_LIMITED reopen
- `functions/src/callables/video.ts` — TIME_LIMITED completion without entitlement consume; replay path
- `functions/src/callables/legal.ts` — allows TIME_LIMITED replay past COMPLETED status
- `functions/src/lib/viewingLease.ts` — `assertSessionAccessible` with generic messaging
- `functions/src/callables/manageUsers.ts` — `getStaffPresentationSettings`, `updateStaffPresentationSettings` (platform admin only)

### Admin UI

- `src/modules/admin/UsersPage.tsx` — Presentation column summary; Edit Presentation Settings panel (video dropdown, access method, days)

### Representative workflow

Unchanged — create invitation as before. Video and policy applied automatically from admin configuration.

---

## Backward Compatibility

- Existing users: no `presentationSettings` → company default video + single-view + company TTL
- Existing invitations: missing `accessPolicy` → treated as single-view; behavior unchanged
- Changing user settings affects **new invitations only** — snapshots are authoritative
- If assigned video becomes unavailable, new invite creation fails with friendly message to contact administrator; existing invitations keep snapshotted video where technically possible

---

## Access-Control Enforcement

| Action | Who |
|--------|-----|
| View presentation settings summary | Platform admin (`users:manage` + platform admin role) |
| Edit presentation settings | Platform admin only — server-side enforced |
| Representatives / company managers | Cannot modify own or others' presentation policy |

---

## Activity / Diagnostics Events

- `presentation_policy_applied` — at invitation creation (video, policy, expiration)
- `presentation_reopened` — TIME_LIMITED client reopen during availability window
- `viewing_entitlement_consumed` — single-view successful completion
- `access_denied` — entitlement consumed or policy block
- `invitation_expired` — client attempt after expiration

No invitation tokens or secrets logged.

---

## Tests Performed

Unit tests (`tests/unit/presentationPolicy.test.ts`):

1. Policy normalization defaults to single-view
2. Duration clamping (min 1, max 365, default 7)
3. Access policy summaries for admin UI
4. Single-view blocks completed sessions
5. Time-limited allows completed session replay
6. Single-view+expiration blocks consumed entitlement
7. Expiration detection from `expiresAt`
8. Missing `accessPolicy` treated as single-view (backward compat)
9. Snapshot immutability (invitation fields independent of user profile)

Full suite: **72 tests passed** (`npm test`).

Build: `npm run build:functions && npm run build` — success.

---

## Migration

None. Optional `presentationSettings` on user documents; snapshot fields added only on new invitations.

---

## Deployment

```
npm run deploy:all
```

- New functions: `getStaffPresentationSettings`, `updateStaffPresentationSettings`
- Updated: `createInvite`, `exchangeInviteToken`, video/legal/manageUsers callables, hosting

---

## Remaining Concerns

- Representative `title` / `phone` for invitation email still depend on profile fields (unchanged).
- App Check not enabled in `.env` (pre-existing warning).
- TIME_LIMITED replay skips re-legal acceptance by design — legal evidence from first acceptance preserved.
- Manual end-to-end verification of all policy scenarios in production UI recommended after first admin configuration.
