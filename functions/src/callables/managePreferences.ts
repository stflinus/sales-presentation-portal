import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import { loadStaffContext } from "../lib/authz";
import { db } from "../lib/firebase";

type FollowUpView = "list" | "calendar";

/**
 * Persist staff UI preferences (e.g. dashboard.followUpView).
 * Stored on users/{uid}.preferences — Functions write only.
 */
export const updateUserPreferences = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  const incoming = (request.data?.preferences || {}) as {
    dashboard?: { followUpView?: FollowUpView };
  };
  const followUpView = incoming.dashboard?.followUpView;
  if (followUpView != null && followUpView !== "list" && followUpView !== "calendar") {
    throw new HttpsError(
      "invalid-argument",
      "dashboard.followUpView must be list or calendar.",
    );
  }

  const ref = db.collection("users").doc(ctx.uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "User profile not found.");
  const existing = (snap.data()?.preferences || {}) as Record<string, unknown>;
  const next = {
    ...existing,
    dashboard: {
      ...((existing.dashboard as Record<string, unknown>) || {}),
      ...(followUpView ? { followUpView } : {}),
    },
  };

  await ref.update({
    preferences: next,
    updatedAt: new Date().toISOString(),
    updatedAtServer: FieldValue.serverTimestamp(),
  });

  return { ok: true, preferences: next };
});

export const getUserPreferences = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  const snap = await db.collection("users").doc(ctx.uid).get();
  if (!snap.exists) throw new HttpsError("not-found", "User profile not found.");
  const preferences = (snap.data()?.preferences || {}) as Record<string, unknown>;
  return { preferences };
});
