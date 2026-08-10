import { onCall, HttpsError } from "firebase-functions/v2/https";
import { requireAuth, syncUserClaims } from "../lib/authz";

export const syncClaims = onCall(async (request) => {
  const uid = requireAuth(request);
  try {
    const permissions = await syncUserClaims(uid);
    return { ok: true, permissions };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError("internal", "Failed to sync claims.");
  }
});
