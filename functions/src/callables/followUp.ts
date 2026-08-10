import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  AUDIT_EVENT,
  FOLLOWUP_REMINDER_STATUS,
  FOLLOWUP_STATUS,
  PERMISSIONS,
} from "../shared";
import { assertHasPermission, assertSessionCompanyAccess, loadStaffContext } from "../lib/authz";
import { writeAnalyticsEvent, writeAuditEvent } from "../lib/audit";
import {
  deleteFollowUpCalendarEvent,
  syncFollowUpCalendarEvent,
} from "../lib/calendar/CalendarServiceFacade";
import { db } from "../lib/firebase";
import { clientIpFromRequest } from "../lib/ua";

interface ScheduleFollowUpRequest {
  sessionId: string;
  /** Canonical UTC instant (ISO). */
  scheduledAt: string;
  /** Optional YYYY-MM-DD; derived from scheduledAt when omitted. */
  followUpDate?: string;
  /** Optional HH:mm; derived from scheduledAt when omitted. */
  followUpTime?: string;
  notes?: string;
}

async function assertCanManageFollowUp(
  ctx: Awaited<ReturnType<typeof loadStaffContext>>,
  session: Record<string, unknown>,
) {
  if (session.representativeId === ctx.uid || ctx.isPlatformAdmin) return;
  await assertSessionCompanyAccess(ctx, session);
  if (!ctx.permissions.includes(PERMISSIONS.FOLLOWUPS_READ_COMPANY)) {
    throw new HttpsError("permission-denied", "Not your session.");
  }
}

function dateAndTimeFromIso(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 16);
  return { date, time };
}

/**
 * Schedule or reschedule a follow-up on an existing Presentation.
 * Never creates a second operational record — updates presentationSessions only.
 */
export const scheduleFollowUp = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.FOLLOWUPS_MANAGE_OWN);
  const data = request.data as ScheduleFollowUpRequest;
  const sessionId = String(data.sessionId || "");
  const scheduledAt = String(data.scheduledAt || "");
  const notes = String(data.notes || "").slice(0, 5000);
  const ip = clientIpFromRequest(request.rawRequest?.headers["x-forwarded-for"]);

  if (!sessionId) throw new HttpsError("invalid-argument", "sessionId required.");
  const when = new Date(scheduledAt);
  if (Number.isNaN(when.getTime())) {
    throw new HttpsError("invalid-argument", "Valid scheduledAt ISO timestamp required.");
  }

  const derived = dateAndTimeFromIso(when.toISOString());
  const followUpDate = String(data.followUpDate || derived.date).slice(0, 10);
  const followUpTime = String(data.followUpTime || derived.time).slice(0, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(followUpDate)) {
    throw new HttpsError("invalid-argument", "followUpDate must be YYYY-MM-DD.");
  }
  if (!/^\d{2}:\d{2}$/.test(followUpTime)) {
    throw new HttpsError("invalid-argument", "followUpTime must be HH:mm.");
  }

  const sessionRef = db.collection("presentationSessions").doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) throw new HttpsError("not-found", "Session not found.");
  const session = sessionSnap.data()!;
  await assertCanManageFollowUp(ctx, session);

  const nowIso = new Date().toISOString();
  const whenIso = when.toISOString();

  // Legacy cleanup only: remove sibling followUps doc if one was previously linked.
  const legacyFollowUpId =
    typeof session.followUpId === "string" && session.followUpId
      ? session.followUpId
      : null;
  if (legacyFollowUpId) {
    await db.collection("followUps").doc(legacyFollowUpId).delete().catch(() => undefined);
  }

  const calendarEventId = await syncFollowUpCalendarEvent({
    uid: ctx.uid,
    presentationId: sessionId,
    clientName: String(session.clientName || "Client"),
    scheduledAtIso: whenIso,
    existingEventId:
      typeof session.followUpCalendarEventId === "string"
        ? session.followUpCalendarEventId
        : null,
    notes,
  });

  await sessionRef.update({
    followUpStatus: FOLLOWUP_STATUS.SCHEDULED,
    followUpAt: whenIso,
    followUpDate,
    followUpTime,
    followUpNotes: notes,
    followUpReminderStatus: FOLLOWUP_REMINDER_STATUS.PENDING,
    followUpCalendarEventId:
      calendarEventId || session.followUpCalendarEventId || null,
    followUpId: FieldValue.delete(),
    "analytics.followupScheduledAt": nowIso,
    updatedAt: nowIso,
    updatedAtServer: FieldValue.serverTimestamp(),
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.FOLLOWUP_SCHEDULED,
    sessionId,
    inviteId: session.inviteId,
    representativeId: session.representativeId,
    actorUid: ctx.uid,
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    ipAddress: ip,
    payload: {
      presentationId: sessionId,
      scheduledAt: whenIso,
      followUpDate,
      followUpTime,
    },
  });
  await writeAnalyticsEvent({
    sessionId,
    representativeId: session.representativeId,
    metric: "followup_scheduled",
    value: whenIso,
    videoVersionId: session.videoId,
  });

  return {
    presentationId: sessionId,
    scheduledAt: whenIso,
    followUpDate,
    followUpTime,
    followUpCalendarEventId: calendarEventId || session.followUpCalendarEventId || null,
    calendarSynced: Boolean(calendarEventId),
  };
});

export const completeFollowUp = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.FOLLOWUPS_MANAGE_OWN);
  const sessionId = String(request.data?.sessionId || "");
  if (!sessionId) throw new HttpsError("invalid-argument", "sessionId required.");

  const sessionRef = db.collection("presentationSessions").doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) throw new HttpsError("not-found", "Session not found.");
  const session = sessionSnap.data()!;
  await assertCanManageFollowUp(ctx, session);

  if (
    session.followUpStatus !== FOLLOWUP_STATUS.SCHEDULED &&
    !session.followUpAt
  ) {
    throw new HttpsError("failed-precondition", "No follow-up scheduled.");
  }

  const nowIso = new Date().toISOString();
  const legacyFollowUpId =
    typeof session.followUpId === "string" && session.followUpId
      ? session.followUpId
      : null;
  if (legacyFollowUpId) {
    await db
      .collection("followUps")
      .doc(legacyFollowUpId)
      .update({
        status: FOLLOWUP_STATUS.COMPLETED,
        updatedAt: nowIso,
        updatedAtServer: FieldValue.serverTimestamp(),
      })
      .catch(() => undefined);
  }

  await sessionRef.update({
    followUpStatus: FOLLOWUP_STATUS.COMPLETED,
    followUpReminderStatus: FOLLOWUP_REMINDER_STATUS.NONE,
    "analytics.followupCompletedAt": nowIso,
    updatedAt: nowIso,
    updatedAtServer: FieldValue.serverTimestamp(),
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.FOLLOWUP_COMPLETED,
    sessionId,
    inviteId: session.inviteId,
    representativeId: session.representativeId,
    actorUid: ctx.uid,
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    payload: { presentationId: sessionId },
  });

  return { ok: true, presentationId: sessionId };
});

/**
 * Clear follow-up attributes on the Presentation (does not delete the Presentation).
 */
export const deleteFollowUp = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.FOLLOWUPS_MANAGE_OWN);
  const sessionId = String(request.data?.sessionId || "");
  if (!sessionId) throw new HttpsError("invalid-argument", "sessionId required.");

  const sessionRef = db.collection("presentationSessions").doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) throw new HttpsError("not-found", "Session not found.");
  const session = sessionSnap.data()!;
  await assertCanManageFollowUp(ctx, session);

  if (
    session.followUpStatus !== FOLLOWUP_STATUS.SCHEDULED &&
    session.followUpStatus !== FOLLOWUP_STATUS.COMPLETED &&
    !session.followUpAt
  ) {
    throw new HttpsError("failed-precondition", "No follow-up scheduled.");
  }

  const nowIso = new Date().toISOString();
  const legacyFollowUpId =
    typeof session.followUpId === "string" && session.followUpId
      ? session.followUpId
      : null;
  if (legacyFollowUpId) {
    await db.collection("followUps").doc(legacyFollowUpId).delete().catch(() => undefined);
  }

  await deleteFollowUpCalendarEvent({
    uid: ctx.uid,
    eventId:
      typeof session.followUpCalendarEventId === "string"
        ? session.followUpCalendarEventId
        : null,
  });

  await sessionRef.update({
    followUpStatus: FOLLOWUP_STATUS.NONE,
    followUpAt: FieldValue.delete(),
    followUpDate: FieldValue.delete(),
    followUpTime: FieldValue.delete(),
    followUpNotes: FieldValue.delete(),
    followUpCalendarEventId: FieldValue.delete(),
    followUpReminderStatus: FOLLOWUP_REMINDER_STATUS.CANCELLED,
    followUpId: FieldValue.delete(),
    updatedAt: nowIso,
    updatedAtServer: FieldValue.serverTimestamp(),
  });

  await writeAuditEvent({
    type: AUDIT_EVENT.REPRESENTATIVE_ACTION,
    sessionId,
    inviteId: session.inviteId,
    representativeId: session.representativeId,
    actorUid: ctx.uid,
    actorType: ctx.isPlatformAdmin ? "administrator" : "representative",
    payload: { action: "clear_follow_up", presentationId: sessionId },
  });

  return { ok: true, presentationId: sessionId };
});
