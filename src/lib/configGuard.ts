/**
 * Frontend production configuration guard.
 * Production builds fail fast on missing Firebase config or emulator flags.
 */

const REQUIRED = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
] as const;

export function assertClientConfig(): void {
  const missing = REQUIRED.filter((key) => !import.meta.env[key]);

  if (import.meta.env.PROD && import.meta.env.VITE_USE_EMULATORS === "true") {
    throw new Error(
      "VITE_USE_EMULATORS=true is not allowed in production builds.",
    );
  }

  if (missing.length > 0) {
    const message = `Missing Firebase web configuration: ${missing.join(", ")}. Copy .env.example to .env and fill values from the Firebase console.`;
    if (import.meta.env.PROD) {
      throw new Error(message);
    }
    console.error(`[SPP] ${message}`);
    return;
  }

  if (import.meta.env.PROD && import.meta.env.VITE_USE_APP_CHECK !== "true") {
    console.warn(
      "[SPP] TEMPORARY SECURITY EXCEPTION: App Check is not enabled (VITE_USE_APP_CHECK!=true). Enable before broad production use. See docs/APP_CHECK.md.",
    );
  }
}
