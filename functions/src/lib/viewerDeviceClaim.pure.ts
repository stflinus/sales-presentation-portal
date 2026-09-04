/**
 * Pure helpers for invitation-link device claim (OTP removed).
 * No Firebase dependencies — unit-testable race outcomes.
 */

/**
 * Resolve whether a device may claim / resume an invitation binding.
 * Cookie value is the opaque authorizedSessionId (not a browser fingerprint).
 */
export function resolveViewerDeviceClaim(input: {
  existingAuthorizedSessionId: string | null | undefined;
  requestCookie: string | null | undefined;
}): "claim" | "same_device" | "blocked" {
  const existing = String(input.existingAuthorizedSessionId || "").trim();
  const cookie = String(input.requestCookie || "").trim();
  if (!existing) return "claim";
  if (cookie && cookie === existing) return "same_device";
  return "blocked";
}

/** Elderly-friendly copy when a second browser/device opens the same invite. */
export const VIEWER_DEVICE_BLOCKED_MESSAGE =
  "This presentation has already been opened on another device.\n\nPlease use the original device, or contact your representative for assistance.";
