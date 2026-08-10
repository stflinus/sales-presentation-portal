import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import { PERMISSIONS } from "../shared";
import { assertHasPermission, loadStaffContext } from "../lib/authz";
import { db } from "../lib/firebase";
import { DefaultCalendarService } from "../lib/calendar/CalendarService";
import {
  GoogleCalendarProvider,
  isGoogleOAuthConfigured,
} from "../lib/calendar/GoogleCalendarProvider";
import {
  ensureGoogleAccessToken,
  googleConnectionCapabilities,
  loadOwnGoogleConnection,
  signCalendarOAuthState,
  verifyCalendarOAuthState,
} from "../lib/calendar/calendarAccess";
import { decryptSecret, encryptSecret } from "../lib/calendar/tokenCrypto";

function calendarService() {
  return new DefaultCalendarService(
    new Map([["google", new GoogleCalendarProvider()]]),
  );
}

function appOrigin(): string {
  return (process.env.APP_ORIGIN || "https://presentationhub.web.app").replace(
    /\/$/,
    "",
  );
}

/** Public status — never returns tokens. */
export const getCalendarConnectionStatus = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.CALENDAR_CONNECT_OWN);
  const conn = await loadOwnGoogleConnection(ctx.uid);
  const caps = googleConnectionCapabilities(conn);
  return {
    connected: caps.connected,
    provider: caps.connected ? "google" : null,
    email: caps.email,
    needsReconnect: caps.needsReconnect,
    oauthConfigured: isGoogleOAuthConfigured(),
    gmail: caps.gmail && !caps.needsReconnect,
    calendar: caps.calendar && !caps.needsReconnect,
    scope: caps.scope,
  };
});

export const getCalendarOAuthUrl = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.CALENDAR_CONNECT_OWN);
  if (!isGoogleOAuthConfigured()) {
    return { configured: false, url: null };
  }
  const provider = calendarService().defaultProvider();
  const url = provider.getAuthUrl(signCalendarOAuthState(ctx.uid));
  return { configured: true, url };
});

/**
 * OAuth redirect handler. Stores encrypted tokens server-side.
 * Never exposes tokens to the browser (redirect only).
 */
export const googleCalendarOAuthCallback = onRequest(async (req, res) => {
  const origin = appOrigin();
  try {
    const err = String(req.query.error || "");
    if (err) {
      res.redirect(
        `${origin}/app?google=error&reason=${encodeURIComponent(err)}#google-integration`,
      );
      return;
    }
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    if (!code || !state) {
      res.status(400).send("Missing code/state");
      return;
    }
    const uid = verifyCalendarOAuthState(state);
    const provider = calendarService().defaultProvider();
    const tokens = await provider.exchangeCode(code);
    const existing = await loadOwnGoogleConnection(uid);
    const encryptedRefresh = tokens.refreshToken
      ? encryptSecret(tokens.refreshToken)
      : existing?.encryptedRefreshToken || null;
    if (!encryptedRefresh) {
      res.redirect(
        `${origin}/app?google=error&reason=missing_refresh_token#google-integration`,
      );
      return;
    }
    await db.collection("calendarConnections").doc(uid).set(
      {
        uid,
        provider: "google",
        email: tokens.email,
        scope: tokens.scope,
        encryptedAccessToken: encryptSecret(tokens.accessToken),
        encryptedRefreshToken: encryptedRefresh,
        accessTokenExpiresAt: tokens.expiresAt,
        connectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        updatedAtServer: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    res.redirect(`${origin}/app?google=connected#google-integration`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "oauth_failed";
    res.redirect(
      `${origin}/app?google=error&reason=${encodeURIComponent(msg)}#google-integration`,
    );
  }
});

export const disconnectGoogleCalendar = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.CALENDAR_CONNECT_OWN);
  const conn = await loadOwnGoogleConnection(ctx.uid);
  if (conn?.encryptedAccessToken) {
    try {
      const token = decryptSecret(String(conn.encryptedAccessToken));
      await calendarService().defaultProvider().revoke?.(token);
    } catch {
      // best-effort revoke
    }
  }
  await db.collection("calendarConnections").doc(ctx.uid).delete();
  return { ok: true, connected: false };
});

/** List the caller's own Google Calendar events — never another user's. */
export const listOwnCalendarEvents = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.CALENDAR_CONNECT_OWN);

  const requestedUid = String(request.data?.uid || ctx.uid);
  if (requestedUid !== ctx.uid) {
    throw new HttpsError(
      "permission-denied",
      "Users may only view their own Google Calendar.",
    );
  }

  const accessToken = await ensureGoogleAccessToken(ctx.uid);
  const now = new Date();
  const end = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const events = await calendarService().defaultProvider().listEvents(
    accessToken,
    {
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      maxResults: 50,
    },
  );

  return {
    events: events.map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start,
      end: e.end,
      htmlLink: e.htmlLink,
    })),
  };
});
