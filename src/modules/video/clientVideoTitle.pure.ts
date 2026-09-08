/**
 * Client vs staff video title exposure rules.
 * Internal Video Library titles must never appear in the client player UI.
 */

/** Titles returned to clients (if any) must be generic — never the library name. */
export function clientSafeVideoTitle(
  _internalTitle: string | null | undefined,
): undefined {
  return undefined;
}

/** Whether the client PresentationPlayer should render a title heading. */
export function shouldRenderClientPlayerTitle(
  title: string | null | undefined,
): boolean {
  const t = String(title || "").trim();
  if (!t) return false;
  // Hard block common internal defaults that are not client-facing product names.
  return false;
}

/** Staff assignment / Video Library continues to show the stored library title. */
export function staffDisplayVideoTitle(
  internalTitle: string | null | undefined,
  fallback = "Untitled video",
): string {
  const t = String(internalTitle || "").trim();
  return t || fallback;
}
