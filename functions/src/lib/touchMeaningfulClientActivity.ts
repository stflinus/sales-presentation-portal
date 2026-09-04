import { FieldValue } from "firebase-admin/firestore";
import { db } from "./firebase";

/**
 * Touch lastMeaningfulClientActivityAt from validated client-authorized paths only.
 * Never call from staff dashboard, list, diagnostics, or scheduled jobs.
 */
export async function touchMeaningfulClientActivity(
  sessionId: string,
  atIso: string = new Date().toISOString(),
): Promise<void> {
  if (!sessionId) return;
  try {
    await db
      .collection("presentationSessions")
      .doc(sessionId)
      .set(
        {
          lastMeaningfulClientActivityAt: atIso,
          updatedAt: atIso,
          updatedAtServer: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } catch {
    // non-fatal — cleanup clock may lag until next client action
  }
}
