/**
 * Google OAuth configuration — credentials never exposed to the browser.
 * Prefer GOOGLE_CLIENT_* ; fall back to legacy GOOGLE_OAUTH_* during migration.
 */

export const GOOGLE_WORKSPACE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

export function googleClientId(): string {
  return (
    process.env.GOOGLE_CLIENT_ID?.trim() ||
    process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() ||
    ""
  );
}

export function googleClientSecret(): string {
  return (
    process.env.GOOGLE_CLIENT_SECRET?.trim() ||
    process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ||
    ""
  );
}

export function googleRedirectUri(): string {
  const explicit = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const origin = (
    process.env.APP_ORIGIN || "https://presentationhub.web.app"
  ).replace(/\/$/, "");
  return `${origin}/oauth/google/calendar`;
}

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(googleClientId() && googleClientSecret());
}

export function scopeIncludesGmail(scope: string | null | undefined): boolean {
  const s = String(scope || "");
  return s.includes("gmail.send");
}

export function scopeIncludesCalendar(scope: string | null | undefined): boolean {
  const s = String(scope || "");
  return s.includes("calendar.events") || s.includes("calendar");
}
