/**
 * Pure helpers for client PresentationPlayer source stability.
 * Changing <video src> mid-playback forces a media reload/rebuffer.
 */

/** Lease/heartbeat must not replace an already-working signed URL. */
export function shouldApplyLeaseVideoUrl(input: {
  existingSrc: string | null | undefined;
  leaseVideoUrl: string | null | undefined;
}): boolean {
  const existing = String(input.existingSrc || "").trim();
  const next = String(input.leaseVideoUrl || "").trim();
  if (!next) return false;
  // Keep the URL from grantVideoAccess; lease mint is for auth bookkeeping only.
  if (existing) return false;
  return true;
}

/** Whether a concurrent lease-acquire call should start. */
export function shouldStartLeaseAcquire(input: {
  alreadyAcquired: boolean;
  inFlight: boolean;
  currentTimeSeconds: number;
  meaningfulPlaybackSeconds: number;
}): boolean {
  if (input.alreadyAcquired || input.inFlight) return false;
  if (!Number.isFinite(input.currentTimeSeconds)) return false;
  return input.currentTimeSeconds >= input.meaningfulPlaybackSeconds;
}
