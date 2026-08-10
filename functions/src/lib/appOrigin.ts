/**
 * Public web origin for invite/email deep links.
 * Optional — missing origin yields relative paths; does not block deploy.
 */
export function resolveAppOrigin(requestOrigin?: string | null): string {
  const fromEnv = (process.env.APP_ORIGIN || "").trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (requestOrigin) return requestOrigin.replace(/\/$/, "");
  return "";
}
