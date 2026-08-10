# Sales Presentation Portal (v0.1)

Production-oriented sales presentation platform for representative-led, one-time secure client viewings.

## Stack

- React + TypeScript + Vite
- Firebase Auth, Firestore, Storage, Hosting, Cloud Functions v2
- Google Calendar-ready follow-up model (Firestore first in v0.1)
- SMTP email on presentation completion

## Modules

| Module | Responsibility |
| --- | --- |
| `auth` / `rbac` | Staff login, custom claims, permission checks |
| `dashboard` | Live client status, notes, follow-ups |
| `invites` | Opaque hashed invitation tokens |
| `legal` | Versioned NDA / Terms / Privacy + immutable acceptances |
| `video` | Private Storage + signed URL playback after legal gate |
| `scheduling` | Follow-up records (Calendar sync hook later) |
| `admin` | Bootstrap / future administration |

## Quick start

1. Copy `.env.example` → `.env` and fill Firebase web config.
2. Set `.firebaserc` project id to your **existing** Firebase project.
3. Install and build shared contracts:

```bash
npm install
npm run build:shared
cd functions && npm install && cd ..
```

4. Deploy rules/functions/hosting (from a machine with Firebase CLI auth):

```bash
npm run build:functions
firebase deploy --only firestore:rules,firestore:indexes,storage,functions,hosting --project sales-presentation-portal
```

Hosting deploys to site `presentationhub` → https://presentationhub.web.app

5. Create the first Auth user in Firebase Console (email/password).
6. Sign in at `/login`, then open `/bootstrap` once.
7. Upload the presentation file to the Storage path returned by bootstrap:

```bash
gsutil cp ./presentation.mp4 gs://YOUR_BUCKET/videos/VIDEO_ID/source.mp4
```

8. Replace placeholder NDA / Terms / Privacy in Firestore (`legalDocuments`) before real clients.
9. Configure SMTP secrets for completion email:

```bash
firebase functions:secrets:set SMTP_HOST
firebase functions:secrets:set SMTP_PORT
firebase functions:secrets:set SMTP_USER
firebase functions:secrets:set SMTP_PASS
firebase functions:secrets:set SMTP_FROM
```

10. Keep Functions env `APP_ORIGIN=https://presentationhub.web.app` (used in email/invite deep links).

## Client flow

`/i/:token` → token exchange → legal bundle → immutable acceptance → signed video → heartbeat/completion → session permanently closed → rep email + dashboard update.

## Security notes

- Storage is deny-all for client SDKs.
- Privileged writes go through callables.
- Invite tokens are stored hashed.
- Viewing uses a **90s server lease** started on meaningful playback (see `docs/VIEWING_LEASE.md`).
- Placeholder legal docs cannot be used for invitations.
- Completed sessions cannot be reopened; create a new invitation for another viewing.
- Browser download/PIP blocks are best-effort only — they do **not** stop screen capture or external cameras.
- App Check is a **temporary exception** until enforced — see `docs/APP_CHECK.md`.

## Verification

```bash
npm test
# with Firestore emulator running:
npm run test:rules
npm run verify:production
```

Deployment status (single source of truth): `docs/reports/FirebaseDeployment.md`.

## v0.1 shortcuts

- Invite delivery is copy-link (not system email send).
- Google Calendar sync is designed (`calendarEventId` field) but not implemented yet.
- Admin content management UI is bootstrap + Firestore/Storage ops; full admin screens are v0.2+.
- Legal placeholders must be replaced before production client use.
