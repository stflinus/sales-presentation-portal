import type {
  CalendarProvider,
  CalendarEventView,
  ListEventsInput,
} from "../calendar/CalendarService";
import {
  GOOGLE_WORKSPACE_SCOPES,
  googleClientId,
  googleClientSecret,
  googleRedirectUri,
  isGoogleOAuthConfigured,
} from "../google/googleOAuthConfig";

export { isGoogleOAuthConfigured, googleRedirectUri as googleOAuthRedirectUri };

function requireClientId(): string {
  const id = googleClientId();
  if (!id) throw new Error("GOOGLE_CLIENT_ID is not configured.");
  return id;
}

function requireClientSecret(): string {
  const secret = googleClientSecret();
  if (!secret) throw new Error("GOOGLE_CLIENT_SECRET is not configured.");
  return secret;
}

/**
 * Google Workspace provider — Gmail send + Calendar events via one OAuth grant.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly id = "google" as const;

  getAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: requireClientId(),
      redirect_uri: googleRedirectUri(),
      response_type: "code",
      scope: GOOGLE_WORKSPACE_SCOPES,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCode(code: string) {
    const body = new URLSearchParams({
      code,
      client_id: requireClientId(),
      client_secret: requireClientSecret(),
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    });
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(
        `Google token exchange failed: ${String(json.error || res.status)}`,
      );
    }
    const accessToken = String(json.access_token || "");
    const refreshToken = json.refresh_token
      ? String(json.refresh_token)
      : null;
    const expiresIn = Number(json.expires_in || 3600);
    const email = await this.fetchEmail(accessToken);
    return {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      email,
      scope: String(json.scope || GOOGLE_WORKSPACE_SCOPES),
    };
  }

  async refreshAccessToken(refreshToken: string) {
    const body = new URLSearchParams({
      client_id: requireClientId(),
      client_secret: requireClientSecret(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(
        `Google token refresh failed: ${String(json.error || res.status)}`,
      );
    }
    return {
      accessToken: String(json.access_token || ""),
      expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
    };
  }

  async listEvents(
    accessToken: string,
    input: ListEventsInput,
  ): Promise<CalendarEventView[]> {
    const params = new URLSearchParams({
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(input.maxResults || 50),
    });
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const json = (await res.json()) as {
      items?: Array<Record<string, unknown>>;
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new Error(json.error?.message || "Failed to list calendar events.");
    }
    return (json.items || []).map((item) => {
      const start = item.start as
        | { dateTime?: string; date?: string }
        | undefined;
      const end = item.end as { dateTime?: string; date?: string } | undefined;
      return {
        id: String(item.id || ""),
        summary: String(item.summary || ""),
        start: start?.dateTime || start?.date || null,
        end: end?.dateTime || end?.date || null,
        htmlLink: item.htmlLink ? String(item.htmlLink) : null,
      };
    });
  }

  async upsertEvent(
    accessToken: string,
    input: {
      eventId?: string | null;
      summary: string;
      description?: string;
      startIso: string;
      endIso: string;
    },
  ): Promise<string> {
    const body = {
      summary: input.summary,
      description: input.description || "",
      start: { dateTime: input.startIso },
      end: { dateTime: input.endIso },
    };
    const existing = (input.eventId || "").trim();
    const url = existing
      ? `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(existing)}`
      : "https://www.googleapis.com/calendar/v3/calendars/primary/events";
    const res = await fetch(url, {
      method: existing ? "PATCH" : "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      id?: string;
      error?: { message?: string };
    };
    if (!res.ok || !json.id) {
      throw new Error(json.error?.message || "Failed to upsert calendar event.");
    }
    return json.id;
  }

  async deleteEvent(accessToken: string, eventId: string): Promise<void> {
    const id = eventId.trim();
    if (!id) return;
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
  }

  async revoke(accessToken: string): Promise<void> {
    await fetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(accessToken)}`,
      { method: "POST" },
    );
  }

  private async fetchEmail(accessToken: string): Promise<string | null> {
    try {
      const res = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!res.ok) return null;
      const json = (await res.json()) as { email?: string };
      return json.email || null;
    } catch {
      return null;
    }
  }
}
