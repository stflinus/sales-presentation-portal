import { randomUUID } from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import {
  ACTIVITY_EVENT,
  ACTIVITY_SEVERITY,
  APP_VERSION,
  PRESENTATION_HEALTH,
  recommendedActionFor,
  rollupPresentationHealth,
  type ActivitySeverity,
  type PresentationHealthStatus,
} from "../shared";
import { db } from "./firebase";
import type { ClientEnvironment } from "./ua";
import { writePresentationActivity } from "./presentationActivity";

export function newCorrelationId(): string {
  try {
    return randomUUID();
  } catch {
    return `corr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function exceptionTypeOf(err: unknown): string {
  if (err && typeof err === "object" && "name" in err) {
    return String((err as { name?: string }).name || "Error");
  }
  return typeof err;
}

function stackOf(err: unknown): string | null {
  if (err && typeof err === "object" && "stack" in err) {
    return String((err as { stack?: string }).stack || "").slice(0, 8000) || null;
  }
  return null;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err || "Unknown exception").slice(0, 500);
}

/**
 * Log unexpected exceptions server-side (Cloud Logging + activity diagnostics).
 * Never throws — diagnostics must not break the primary flow.
 */
export async function logUnexpectedException(input: {
  err: unknown;
  sessionId?: string | null;
  inviteId?: string | null;
  companyId?: string | null;
  representativeId?: string | null;
  cloudFunction: string;
  errorCode?: string;
  firestoreCollection?: string | null;
  documentId?: string | null;
  storageObject?: string | null;
  env?: Partial<ClientEnvironment> | null;
  ipAddress?: string | null;
  screenResolution?: string | null;
  networkStatus?: string | null;
  actorUid?: string | null;
  actorType?: "system" | "representative" | "administrator" | "client";
  severity?: ActivitySeverity;
}): Promise<{ correlationId: string }> {
  const correlationId = newCorrelationId();
  const errorCode = input.errorCode || "UNEXPECTED_EXCEPTION";
  const summary = messageOf(input.err);
  const exType = exceptionTypeOf(input.err);
  const stack = stackOf(input.err);

  console.error(
    JSON.stringify({
      severity: "ERROR",
      message: "presentation_unexpected_exception",
      correlationId,
      cloudFunction: input.cloudFunction,
      errorCode,
      exceptionType: exType,
      sessionId: input.sessionId || null,
      inviteId: input.inviteId || null,
      summary,
      stack,
    }),
  );

  if (input.sessionId) {
    try {
      await writePresentationActivity({
        sessionId: input.sessionId,
        inviteId: input.inviteId,
        companyId: input.companyId,
        representativeId: input.representativeId,
        type: ACTIVITY_EVENT.UNEXPECTED_EXCEPTION,
        severity: input.severity || ACTIVITY_SEVERITY.ERROR,
        description: "An unexpected problem occurred during the presentation workflow.",
        errorCode,
        env: input.env,
        ipAddress: input.ipAddress,
        actorType: input.actorType || "system",
        actorUid: input.actorUid,
        diagnostics: {
          errorSummary: summary,
          errorCode,
          exceptionType: exType,
          cloudFunction: input.cloudFunction,
          firestoreCollection: input.firestoreCollection || null,
          documentId: input.documentId || null,
          storageObject: input.storageObject || null,
          browser: input.env?.browser || null,
          browserVersion: input.env?.browserVersion || null,
          deviceType: input.env?.deviceType || null,
          operatingSystem: input.env?.operatingSystem || null,
          screenResolution: input.screenResolution || null,
          networkStatus: input.networkStatus || null,
          correlationId,
          stackTrace: stack,
          recommendedAction: recommendedActionFor(errorCode, ACTIVITY_EVENT.UNEXPECTED_EXCEPTION),
          ipAddress: input.ipAddress || null,
          userAgent: input.env?.userAgent || null,
          appVersion: APP_VERSION,
        },
        payload: { correlationId, cloudFunction: input.cloudFunction },
      });
    } catch (writeErr) {
      console.error("failed_to_write_exception_activity", writeErr);
    }
  }

  return { correlationId };
}

export async function recomputeSessionHealth(sessionId: string): Promise<PresentationHealthStatus> {
  const snap = await db
    .collection("presentationActivity")
    .where("sessionId", "==", sessionId)
    .orderBy("createdAt", "desc")
    .limit(200)
    .get();

  const severities = snap.docs.map((d) => String(d.data().severity || ""));
  const health = rollupPresentationHealth(severities);

  let summary = "No issues detected.";
  if (health === PRESENTATION_HEALTH.ERROR) {
    const err = snap.docs.find((d) => d.data().severity === ACTIVITY_SEVERITY.ERROR);
    summary =
      String(err?.data()?.diagnostics?.errorSummary || err?.data()?.description || "").slice(
        0,
        240,
      ) || "An error was recorded for this presentation.";
  } else if (health === PRESENTATION_HEALTH.WARNING) {
    const warn = snap.docs.find((d) => d.data().severity === ACTIVITY_SEVERITY.WARNING);
    summary =
      String(warn?.data()?.description || "").slice(0, 240) ||
      "A warning was recorded for this presentation.";
  }

  await db
    .collection("presentationSessions")
    .doc(sessionId)
    .set(
      {
        healthStatus: health,
        healthSummary: summary,
        healthUpdatedAt: new Date().toISOString(),
        updatedAtServer: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

  return health;
}
