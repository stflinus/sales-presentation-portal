# App Check — temporary security exception (v0.1)

## Current status

App Check is **wired but not enforced** on Cloud Functions callables.

- Client: set `VITE_USE_APP_CHECK=true` and `VITE_RECAPTCHA_SITE_KEY=...`
- Functions: callables do **not** yet set `enforceAppCheck: true`

This is an intentional **temporary exception** for the initial controlled deployment
(Dan + known reps). It must be closed before broader production use.

## Exact steps to enable enforcement

1. In Google Cloud / Firebase Console, register the web app for App Check with reCAPTCHA v3.
2. Add the site key to `.env` as `VITE_RECAPTCHA_SITE_KEY` and set `VITE_USE_APP_CHECK=true`.
3. Rebuild and redeploy Hosting.
4. In each sensitive callable (`onCall({ enforceAppCheck: true, ... })`), enable enforcement — start with:
   - `exchangeInviteToken`
   - `acceptLegal`
   - `grantVideoAccess`
   - `acquireViewingLease`
   - `heartbeatPlayback`
   - `completeVideo`
   - `createInvite`
5. Deploy Functions.
6. Confirm legitimate clients succeed and unauthenticated scripted callable abuse fails.
7. Remove the temporary-exception warning from `validateProductionReadiness` / README once enforced.
