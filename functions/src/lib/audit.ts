import { FieldValue } from "firebase-admin/firestore";
import type { AuditEventType } from "../shared";
import { db } from "./firebase";

export async function writeAuditEvent(input: {
  type: AuditEventType;
  sessionId?: string;
  inviteId?: string;
  representativeId?: string;
  actorUid?: string;
  actorType: "system" | "representative" | "administrator" | "client";
  payload?: Record<string, unknown>;
  ipAddress?: string;
}): Promise<string> {
  const ref = db.collection("auditEvents").doc();
  await ref.set({
    id: ref.id,
    type: input.type,
    sessionId: input.sessionId ?? null,
    inviteId: input.inviteId ?? null,
    representativeId: input.representativeId ?? null,
    actorUid: input.actorUid ?? null,
    actorType: input.actorType,
    payload: input.payload ?? {},
    ipAddress: input.ipAddress ?? null,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function writeAnalyticsEvent(input: {
  sessionId: string;
  representativeId: string;
  metric: string;
  value: unknown;
  videoVersionId?: string;
}): Promise<void> {
  const ref = db.collection("analyticsEvents").doc();
  await ref.set({
    id: ref.id,
    sessionId: input.sessionId,
    representativeId: input.representativeId,
    metric: input.metric,
    value: input.value,
    videoVersionId: input.videoVersionId ?? null,
    createdAt: FieldValue.serverTimestamp(),
  });
}
