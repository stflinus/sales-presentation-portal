# Go-live checklist (Dan / this week)

1. Set `.firebaserc` → existing Firebase project ID
2. Fill `.env` from Firebase Console web app config
3. `npm install && npm run build && npm run build:functions`
4. `firebase deploy --only firestore:rules,firestore:indexes,storage,functions,hosting --project sales-presentation-portal` (Hosting site: `presentationhub` → https://presentationhub.web.app)
5. Enable Email/Password auth in Firebase Console
6. Create Dan’s Auth user
7. Sign in → `/bootstrap`
8. Upload MP4 to Storage path from bootstrap (or `registerVideo` after upload)
9. Publish real NDA / Terms / Privacy via `publishLegalDocument` callable (or Console + matching SHA-256)
10. Set SMTP secrets + `APP_ORIGIN=https://presentationhub.web.app`
11. Optional: enable App Check + `VITE_USE_APP_CHECK=true`
12. Send a test invite to yourself end-to-end before a real client
