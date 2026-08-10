import { FieldValue } from "firebase-admin/firestore";
import {
  ACTIVITY_EVENT_LABEL,
  ACTIVITY_SEVERITY,
  APP_VERSION,
  PRESENTATION_HEALTH,
  recommendedActionFor,
  type ActivityDiagnostics,
  type ActivityEventType,
  type ActivitySeverity,
} from "../shared";
import { db } from "./firebase";
import type { ClientEnvironment } from "./ua";

const HEALTH_RANK: Record<string, number> = {
  [PRESENTATION_HEALTH.HEALTHY]: 0,
  [PRESENTATION_HEALTH.WARNING]: 1,
  [PRESENTATION_HEALTH.ERROR]: 2,
};

export async function writePresentationActivity(input: {
  sessionId: string;
  inviteId?: string | null;
  companyId?: string | null;
  representativeId?: string | null;
  type: ActivityEventType | string;
  severity?: ActivitySeverity;
  title?: string;
  description: string;
  errorCode?: string | null;
  env?: Partial<ClientEnvironment> | null;
  ipAddress?: string | null;
  actorType: "system" | "representative" | "administrator" | "client";
  actorUid?: string | null;
  payload?: Record<string, unknown>;
  diagnostics?: ActivityDiagnostics | null;
  screenResolution?: string | null;
  networkStatus?: string | null;
  cloudFunction?: string | null;
}): Promise<string> {
  const ref = db.collection("presentationActivity").doc();
  const title =
    input.title ||
    ACTIVITY_EVENT_LABEL[input.type] ||
    String(input.type).replaceAll("_", " ");
  const createdAtIso = new Date().toISOString();
  const severity = input.severity || ACTIVITY_SEVERITY.INFO;
  const errorCode = input.errorCode ?? input.diagnostics?.errorCode ?? null;

  const diagnostics: ActivityDiagnostics | null =
    severity === ACTIVITY_SEVERITY.ERROR ||
    severity === ACTIVITY_SEVERITY.WARNING ||
    input.diagnostics
      ? {
          errorSummary:
            input.diagnostics?.errorSummary ||
            (severity === ACTIVITY_SEVERITY.ERROR ||
            severity === ACTIVITY_SEVERITY.WARNING
              ? input.description
              : null),
          errorCode,
          exceptionType: input.diagnostics?.exceptionType || null,
          cloudFunction:
            input.diagnostics?.cloudFunction || input.cloudFunction || null,
          firestoreCollection: input.diagnostics?.firestoreCollection || null,
          documentId: input.diagnostics?.documentId || null,
          storageObject: input.diagnostics?.storageObject || null,
          browser: input.diagnostics?.browser || input.env?.browser || null,
          browserVersion:
            input.diagnostics?.browserVersion ||
            input.env?.browserVersion ||
            null,
          deviceType:
            input.diagnostics?.deviceType || input.env?.deviceType || null,
          operatingSystem:
            input.diagnostics?.operatingSystem ||
            input.env?.operatingSystem ||
            null,
          screenResolution:
            input.diagnostics?.screenResolution ||
            input.screenResolution ||
            null,
          networkStatus:
            input.diagnostics?.networkStatus || input.networkStatus || null,
          correlationId: input.diagnostics?.correlationId || null,
          stackTrace: input.diagnostics?.stackTrace || null,
          recommendedAction:
            input.diagnostics?.recommendedAction ||
            (severity === ACTIVITY_SEVERITY.ERROR ||
            severity === ACTIVITY_SEVERITY.WARNING
              ? recommendedActionFor(errorCode, String(input.type))
              : null),
          ipAddress: input.diagnostics?.ipAddress || input.ipAddress || null,
          userAgent: input.diagnostics?.userAgent || input.env?.userAgent || null,
          appVersion: input.diagnostics?.appVersion || APP_VERSION,
        }
      : null;

  await ref.set({
    id: ref.id,
    sessionId: input.sessionId,
    inviteId: input.inviteId ?? null,
    companyId: input.companyId ?? null,
    representativeId: input.representativeId ?? null,
    type: input.type,
    severity,
    title,
    description: input.description,
    errorCode,
    deviceType: input.env?.deviceType ?? null,
    browser: input.env?.browser ?? null,
    browserVersion: input.env?.browserVersion ?? null,
    operatingSystem: input.env?.operatingSystem ?? null,
    userAgent: input.env?.userAgent ?? null,
    ipAddress: input.ipAddress ?? null,
    actorType: input.actorType,
    actorUid: input.actorUid ?? null,
    payload: input.payload ?? {},
    diagnostics,
    createdAt: createdAtIso,
    createdAtServer: FieldValue.serverTimestamp(),
  });

  // Escalate session health rollup (never throw).
  try {
    const nextHealth =
      severity === ACTIVITY_SEVERITY.ERROR
        ? PRESENTATION_HEALTH.ERROR
        : severity === ACTIVITY_SEVERITY.WARNING
          ? PRESENTATION_HEALTH.WARNING
          : PRESENTATION_HEALTH.HEALTHY;
    const sessionRef = db.collection("presentationSessions").doc(input.sessionId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(sessionRef);
      if (!snap.exists) return;
      const current = String(snap.data()?.healthStatus || PRESENTATION_HEALTH.HEALTHY);
      if ((HEALTH_RANK[nextHealth] || 0) < (HEALTH_RANK[current] || 0)) return;
      if (nextHealth === PRESENTATION_HEALTH.HEALTHY && snap.data()?.healthStatus) {
        // Do not overwrite existing warning/error with healthy on success events.
        if (current !== PRESENTATION_HEALTH.HEALTHY) return;
      }
      const summary =
        nextHealth === PRESENTATION_HEALTH.HEALTHY
          ? "No issues detected."
          : input.description.slice(0, 240);
      tx.update(sessionRef, {
        healthStatus: nextHealth,
        healthSummary: summary,
        healthUpdatedAt: createdAtIso,
        updatedAtServer: FieldValue.serverTimestamp(),
      });
    });
  } catch (err) {
    console.error("session_health_update_failed", err);
  }

  return ref.id;
}
