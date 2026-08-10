/**
 * Staff-safe error messages — never surface INTERNAL, Firebase, stacks, or codes.
 * Representatives and non-admin staff see only friendly copy.
 */

const FRIENDLY_DEFAULT =
  "We're sorry, but there was a problem completing that action. Please try again or contact an administrator for assistance.";

const FRIENDLY_LOAD =
  "We're sorry, but there was a problem loading your presentation.\n\nPlease contact your representative for assistance.";

const LOOKS_TECHNICAL =
  /\b(internal|firebase|firestore|stack|exception|httpserror|functions\/|gs:\/\/|cors|permission-denied|unauthenticated|deadline-exceeded|resource-exhausted)\b/i;

export function staffFriendlyError(
  err: unknown,
  fallback: string = FRIENDLY_DEFAULT,
): string {
  if (!err) return fallback;
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err && "message" in err
        ? String((err as { message: unknown }).message || "")
        : String(err);

  const cleaned = message
    .replace(/FirebaseError[:\s]*/gi, "")
    .replace(/functions\/[a-z-]+/gi, "")
    .trim();

  if (!cleaned || LOOKS_TECHNICAL.test(cleaned) || cleaned.length > 180) {
    return fallback;
  }

  // Known safe business messages may pass through.
  if (
    /already been viewed|expired|revoked|not found|another device|required|permission/i.test(
      cleaned,
    ) &&
    !LOOKS_TECHNICAL.test(cleaned)
  ) {
    return cleaned;
  }

  return fallback;
}

export function clientPresentationProblemMessage(): string {
  return FRIENDLY_LOAD;
}

export function isTechnicalErrorText(text: string): boolean {
  return LOOKS_TECHNICAL.test(text) || /\bINTERNAL\b/.test(text);
}
