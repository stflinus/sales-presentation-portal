import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import {
  ACTIVITY_EVENT,
  ACTIVITY_SEVERITY,
  APP_VERSION,
  PERMISSIONS,
  PRESENTATION_HEALTH,
  recommendedActionFor,
  rollupPresentationHealth,
  type ActivityEventType,
  type ActivitySeverity,
} from "../shared";
import {
  assertHasPermission,
  assertSessionCompanyAccess,
  loadStaffContext,
  requireClientSession,
} from "../lib/authz";
import { writePresentationActivity } from "../lib/presentationActivity";
import { db } from "../lib/firebase";
import { buildSimplePdf } from "../lib/simplePdf";
import { clientIpFromRequest, parseUserAgent } from "../lib/ua";

const CLIENT_ALLOWED_TYPES = new Set<string>([
  ACTIVITY_EVENT.PRESENTATION_READY,
  ACTIVITY_EVENT.START_PRESENTATION_CLICKED,
  ACTIVITY_EVENT.VIDEO_BUFFERING,
  ACTIVITY_EVENT.PLAYBACK_ERROR,
  ACTIVITY_EVENT.BROWSER_CLOSED,
  ACTIVITY_EVENT.NETWORK_FAILURE,
  ACTIVITY_EVENT.NETWORK_RETRY,
  ACTIVITY_EVENT.TIMEOUT,
  ACTIVITY_EVENT.DEVICE_CAPTURED,
  ACTIVITY_EVENT.PROGRESS_UPDATE,
]);

const FRIENDLY_STAFF =
  "We're sorry, but there was a problem loading this presentation. Please contact an administrator for assistance.";

/**
 * Client-side workflow events. Never accepts stack traces.
 */
export const logClientActivity = onCall(async (request) => {
  const sessionId = String(request.data?.sessionId || "");
  const type = String(request.data?.type || "") as ActivityEventType;
  const uid = requireClientSession(request, sessionId);

  if (!CLIENT_ALLOWED_TYPES.has(type)) {
    throw new HttpsError("invalid-argument", "Activity type not allowed.");
  }

  const sessionSnap = await db.collection("presentationSessions").doc(sessionId).get();
  if (!sessionSnap.exists) throw new HttpsError("not-found", "Session not found.");
  const session = sessionSnap.data()!;

  const ip = clientIpFromRequest(request.rawRequest?.headers["x-forwarded-for"]);
  const env = parseUserAgent(request.rawRequest?.headers["user-agent"] || "");
  const severity = (String(request.data?.severity || ACTIVITY_SEVERITY.INFO) ||
    ACTIVITY_SEVERITY.INFO) as ActivitySeverity;
  const errorCode =
    typeof request.data?.errorCode === "string"
      ? String(request.data.errorCode).slice(0, 80)
      : null;
  const description = String(request.data?.description || "")
    .replace(/\n/g, " ")
    .slice(0, 500);

  const safeDescription = description
    .replace(/INTERNAL/gi, "")
    .replace(/FirebaseError[:\s]*/gi, "")
    .replace(/at\s+\S+\s+\([^)]+\)/g, "")
    .trim()
    .slice(0, 400);

  const resolvedSeverity =
    severity === ACTIVITY_SEVERITY.ERROR ||
    severity === ACTIVITY_SEVERITY.WARNING ||
    severity === ACTIVITY_SEVERITY.SUCCESS
      ? severity
      : type === ACTIVITY_EVENT.PLAYBACK_ERROR ||
          type === ACTIVITY_EVENT.NETWORK_FAILURE ||
          type === ACTIVITY_EVENT.TIMEOUT
        ? ACTIVITY_SEVERITY.ERROR
        : type === ACTIVITY_EVENT.VIDEO_BUFFERING ||
            type === ACTIVITY_EVENT.BROWSER_CLOSED ||
            type === ACTIVITY_EVENT.NETWORK_RETRY
          ? ACTIVITY_SEVERITY.WARNING
          : ACTIVITY_SEVERITY.INFO;

  await writePresentationActivity({
    sessionId,
    inviteId: (session.inviteId as string) || null,
    companyId: (session.companyId as string) || null,
    representativeId: (session.representativeId as string) || null,
    type,
    severity: resolvedSeverity,
    description:
      safeDescription ||
      "A presentation workflow event was recorded.",
    errorCode,
    env,
    ipAddress: ip,
    actorType: "client",
    actorUid: uid,
    screenResolution:
      typeof request.data?.screenResolution === "string"
        ? String(request.data.screenResolution).slice(0, 64)
        : null,
    networkStatus:
      typeof request.data?.networkStatus === "string"
        ? String(request.data.networkStatus).slice(0, 64)
        : null,
    cloudFunction: "logClientActivity",
    payload: { clientReported: true },
  });

  const nowIso = new Date().toISOString();
  await db
    .collection("presentationSessions")
    .doc(sessionId)
    .set(
      {
        lastMeaningfulClientActivityAt: nowIso,
        updatedAt: nowIso,
        updatedAtServer: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
    .catch(() => undefined);

  return { ok: true };
});

async function assertCanReadSessionActivity(
  request: import("firebase-functions/v2/https").CallableRequest,
  sessionId: string,
) {
  const ctx = await loadStaffContext(request);
  const snap = await db.collection("presentationSessions").doc(sessionId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Presentation not found.");
  const session = snap.data()!;

  // Full diagnostics: platform administrators only.
  const diagnostics =
    ctx.isPlatformAdmin || ctx.permissions.includes(PERMISSIONS.AUDIT_READ_ALL);

  if (diagnostics) {
    return { ctx, session, diagnostics: true as const };
  }

  if (session.representativeId === ctx.uid) {
    assertHasPermission(ctx, PERMISSIONS.SESSIONS_READ_OWN);
    return { ctx, session, diagnostics: false as const };
  }

  await assertSessionCompanyAccess(ctx, session);
  if (
    !ctx.permissions.includes(PERMISSIONS.SESSIONS_READ_COMPANY) &&
    !ctx.permissions.includes(PERMISSIONS.AUDIT_READ_COMPANY)
  ) {
    throw new HttpsError(
      "permission-denied",
      "Not allowed to view this presentation health panel.",
    );
  }
  return { ctx, session, diagnostics: false as const };
}

function mapActivityDoc(
  id: string,
  data: Record<string, unknown>,
  diagnostics: boolean,
) {
  const base = {
    id,
    sessionId: String(data.sessionId || ""),
    inviteId: (data.inviteId as string | null) || null,
    type: String(data.type || ""),
    severity: String(data.severity || ACTIVITY_SEVERITY.INFO),
    title: String(data.title || data.type || ""),
    description: String(data.description || ""),
    createdAt: (data.createdAt as string) || null,
    actorType: String(data.actorType || ""),
  };
  if (!diagnostics) return base;

  const diag = (data.diagnostics as Record<string, unknown> | null) || {};
  return {
    ...base,
    errorCode: (data.errorCode as string | null) || (diag.errorCode as string) || null,
    deviceType: (data.deviceType as string | null) || null,
    browser: (data.browser as string | null) || null,
    browserVersion: (data.browserVersion as string | null) || null,
    operatingSystem: (data.operatingSystem as string | null) || null,
    userAgent: (data.userAgent as string | null) || null,
    ipAddress: (data.ipAddress as string | null) || null,
    payload: (data.payload as Record<string, unknown>) || {},
    diagnostics: {
      errorSummary: (diag.errorSummary as string) || base.description,
      errorCode: (diag.errorCode as string) || (data.errorCode as string) || null,
      exceptionType: (diag.exceptionType as string) || null,
      cloudFunction: (diag.cloudFunction as string) || null,
      firestoreCollection: (diag.firestoreCollection as string) || null,
      documentId: (diag.documentId as string) || null,
      storageObject: (diag.storageObject as string) || null,
      browser: (diag.browser as string) || (data.browser as string) || null,
      browserVersion:
        (diag.browserVersion as string) || (data.browserVersion as string) || null,
      deviceType: (diag.deviceType as string) || (data.deviceType as string) || null,
      operatingSystem:
        (diag.operatingSystem as string) ||
        (data.operatingSystem as string) ||
        null,
      screenResolution: (diag.screenResolution as string) || null,
      networkStatus: (diag.networkStatus as string) || null,
      correlationId: (diag.correlationId as string) || null,
      stackTrace: (diag.stackTrace as string) || null,
      recommendedAction:
        (diag.recommendedAction as string) ||
        recommendedActionFor(
          (diag.errorCode as string) || (data.errorCode as string),
          base.type,
        ),
      ipAddress: (diag.ipAddress as string) || (data.ipAddress as string) || null,
      userAgent: (diag.userAgent as string) || (data.userAgent as string) || null,
      appVersion: (diag.appVersion as string) || APP_VERSION,
    },
  };
}

/**
 * Presentation Health panel data — chronological timeline + admin diagnostics.
 * Empty activity returns a friendly empty state (never throws for missing data).
 */
export const getPresentationActivityLog = onCall(async (request) => {
  const sessionId = String(request.data?.sessionId || "");
  if (!sessionId) throw new HttpsError("invalid-argument", "sessionId required.");

  let session: Record<string, unknown>;
  let diagnostics: boolean;
  try {
    const result = await assertCanReadSessionActivity(request, sessionId);
    session = result.session as Record<string, unknown>;
    diagnostics = result.diagnostics;
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError("failed-precondition", FRIENDLY_STAFF);
  }

  let events: ReturnType<typeof mapActivityDoc>[] = [];
  try {
    const snap = await db
      .collection("presentationActivity")
      .where("sessionId", "==", sessionId)
      .orderBy("createdAt", "asc")
      .limit(500)
      .get();
    events = snap.docs.map((d) =>
      mapActivityDoc(d.id, d.data() as Record<string, unknown>, diagnostics),
    );
  } catch (err) {
    console.error("getPresentationActivityLog_query_failed", err);
    events = [];
  }

  const health =
    events.length === 0
      ? String(session.healthStatus || PRESENTATION_HEALTH.HEALTHY)
      : rollupPresentationHealth(events.map((e) => e.severity));

  const latestIssue = [...events]
    .reverse()
    .find(
      (e) =>
        e.severity === ACTIVITY_SEVERITY.ERROR ||
        e.severity === ACTIVITY_SEVERITY.WARNING,
    );

  const inviteId = session.inviteId ? String(session.inviteId) : null;

  return {
    sessionId,
    inviteId,
    clientName: session.clientName ? String(session.clientName) : null,
    clientEmail: session.clientEmail ? String(session.clientEmail) : null,
    representativeName: session.representativeName
      ? String(session.representativeName)
      : null,
    status: session.status ? String(session.status) : null,
    diagnostics,
    healthStatus: health,
    healthSummary:
      events.length === 0
        ? "No activity has been recorded for this presentation."
        : health === PRESENTATION_HEALTH.HEALTHY
          ? "No issues detected."
          : String(
              (latestIssue &&
                "diagnostics" in latestIssue &&
                (latestIssue as { diagnostics?: { errorSummary?: string } })
                  .diagnostics?.errorSummary) ||
                latestIssue?.description ||
                session.healthSummary ||
                "Issues were recorded for this presentation.",
            ),
    empty: events.length === 0,
    emptyMessage: "No activity has been recorded for this presentation.",
    appVersion: APP_VERSION,
    events,
  };
});

export const exportPresentationActivityLog = onCall(async (request) => {
  const sessionId = String(request.data?.sessionId || "");
  const format = String(request.data?.format || "json").toLowerCase();
  if (!sessionId) throw new HttpsError("invalid-argument", "sessionId required.");
  const { session, diagnostics } = await assertCanReadSessionActivity(
    request,
    sessionId,
  );

  let events: ReturnType<typeof mapActivityDoc>[] = [];
  try {
    const snap = await db
      .collection("presentationActivity")
      .where("sessionId", "==", sessionId)
      .orderBy("createdAt", "asc")
      .limit(500)
      .get();
    events = snap.docs.map((d) =>
      mapActivityDoc(d.id, d.data() as Record<string, unknown>, diagnostics),
    );
  } catch {
    events = [];
  }

  const packageJson = {
    exportedAt: new Date().toISOString(),
    sessionId,
    inviteId: session.inviteId || null,
    clientName: session.clientName || null,
    clientEmail: session.clientEmail || null,
    representativeName: session.representativeName || null,
    status: session.status || null,
    diagnosticsIncluded: diagnostics,
    appVersion: APP_VERSION,
    eventCount: events.length,
    events,
  };

  if (format === "pdf") {
    const lines: string[] = [
      "Presentation Health Report",
      `Session: ${sessionId}`,
      `Client: ${session.clientName || "—"} <${session.clientEmail || ""}>`,
      `Representative: ${session.representativeName || "—"}`,
      `Status: ${session.status || "—"}`,
      `Exported: ${packageJson.exportedAt}`,
      `Events: ${events.length}`,
      "",
    ];
    if (events.length === 0) {
      lines.push("No activity has been recorded for this presentation.");
    }
    for (const e of events) {
      const ts = e.createdAt || "—";
      lines.push(`[${ts}] (${e.severity}) ${e.title}`);
      lines.push(`  ${e.description}`);
      if (diagnostics && "diagnostics" in e && e.diagnostics) {
        const d = e.diagnostics as {
          errorCode?: string;
          recommendedAction?: string;
          correlationId?: string;
        };
        if (d.errorCode) lines.push(`  Error code: ${d.errorCode}`);
        if (d.correlationId) lines.push(`  Correlation: ${d.correlationId}`);
        if (d.recommendedAction) lines.push(`  Action: ${d.recommendedAction}`);
      }
      lines.push("");
    }
    const pdf = buildSimplePdf(lines.slice(0, 90));
    return {
      format: "pdf",
      fileName: `presentation-health-${sessionId}.pdf`,
      contentBase64: pdf.toString("base64"),
      eventCount: events.length,
    };
  }

  return {
    format: "json",
    fileName: `presentation-health-${sessionId}.json`,
    contentBase64: Buffer.from(JSON.stringify(packageJson, null, 2), "utf8").toString(
      "base64",
    ),
    eventCount: events.length,
  };
});
