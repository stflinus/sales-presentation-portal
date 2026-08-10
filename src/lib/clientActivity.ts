import { httpsCallable } from "firebase/functions";
import {
  ACTIVITY_EVENT,
  ACTIVITY_SEVERITY,
  type ActivityEventType,
  type ActivitySeverity,
} from "@spp/shared";
import { functions } from "@/lib/firebase";

/**
 * Best-effort client activity logging. Never throws to callers.
 * Descriptions must stay friendly — server strips stacks / INTERNAL.
 */
export async function logClientActivity(input: {
  sessionId: string;
  type: ActivityEventType | (typeof ACTIVITY_EVENT)[keyof typeof ACTIVITY_EVENT];
  description: string;
  severity?: ActivitySeverity;
  errorCode?: string;
}): Promise<void> {
  if (!input.sessionId) return;
  try {
    const callable = httpsCallable(functions, "logClientActivity");
    await callable({
      sessionId: input.sessionId,
      type: input.type,
      description: input.description.slice(0, 400),
      severity: input.severity || ACTIVITY_SEVERITY.INFO,
      errorCode: input.errorCode || null,
    });
  } catch {
    // non-fatal — never block the client flow
  }
}

export { ACTIVITY_EVENT, ACTIVITY_SEVERITY };
