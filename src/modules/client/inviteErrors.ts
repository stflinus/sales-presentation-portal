export type InviteErrorKind =
  | "invalid"
  | "expired"
  | "viewed"
  | "revoked"
  | "unavailable";

export interface ClientInviteError {
  kind: InviteErrorKind;
  title: string;
  message: string;
}

const PROBLEM_TITLE = "We're sorry";
const PROBLEM_MESSAGE =
  "We're sorry, but there was a problem loading your presentation.\n\nPlease contact your representative for assistance.";

function rawMessage(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const anyErr = err as {
    message?: string;
    code?: string;
    details?: string;
  };
  return String(anyErr.message || anyErr.details || "").trim();
}

function rawCode(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  return String((err as { code?: string }).code || "")
    .toLowerCase()
    .trim();
}

/**
 * Map Firebase / Functions failures to client-safe copy.
 * Never surfaces INTERNAL, codes, stacks, Firebase, URLs, or function names.
 */
export function mapInviteError(err: unknown): ClientInviteError {
  const message = rawMessage(err);
  const code = rawCode(err);
  const lower = message.toLowerCase();

  if (
    lower.includes("already been viewed") ||
    lower.includes("already been completed") ||
    lower.includes("already viewed")
  ) {
    return {
      kind: "viewed",
      title: "Presentation already completed",
      message:
        "This presentation has already been viewed and cannot be opened again. Please contact your representative if you need assistance.",
    };
  }

  if (lower.includes("expired")) {
    return {
      kind: "expired",
      title: "Invitation expired",
      message:
        "This invitation has expired. Please contact your representative to request a new secure invitation.",
    };
  }

  if (lower.includes("revoked")) {
    return {
      kind: "revoked",
      title: "Invitation unavailable",
      message:
        "This invitation is no longer active. Please contact your representative for a new link.",
    };
  }

  if (
    code.includes("not-found") ||
    lower.includes("not found") ||
    lower.includes("invalid invitation") ||
    lower.includes("unknown_token")
  ) {
    return {
      kind: "invalid",
      title: "Invitation not found",
      message:
        "This invitation link is invalid or incomplete. Please use the secure link provided by your representative.",
    };
  }

  if (lower.includes("another device")) {
    return {
      kind: "unavailable",
      title: "Already open on another device",
      message:
        "This presentation is currently being viewed on another device. Please finish there, or contact your representative for help.",
    };
  }

  // All unexpected / technical failures → fixed friendly copy.
  return {
    kind: "unavailable",
    title: PROBLEM_TITLE,
    message: PROBLEM_MESSAGE,
  };
}

export function mapClientSessionError(err: unknown): ClientInviteError {
  return mapInviteError(err);
}

export { PROBLEM_MESSAGE as CLIENT_PRESENTATION_PROBLEM_MESSAGE };
