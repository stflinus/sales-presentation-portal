import { onCall } from "firebase-functions/v2/https";
import { PERMISSIONS } from "../shared";
import { requirePermission } from "../lib/authz";
import { assessContentReadiness } from "../lib/productionContent";
import { resolveAppOrigin } from "../lib/appOrigin";

/**
 * Admin readiness check — does not deploy, only reports blockers.
 * SMTP missing is a warning, not a blocker (email is optional for v0.1).
 */
export const validateProductionReadiness = onCall(async (request) => {
  requirePermission(request, PERMISSIONS.ADMIN_ACCESS);
  const content = await assessContentReadiness();

  const appOrigin = resolveAppOrigin(null);
  const blockers: string[] = [...content.missing];
  const warnings: string[] = [];

  warnings.push(
    "Confirm Firebase Trigger Email extension is installed and watching the mail/ collection.",
  );
  if (!appOrigin) {
    warnings.push(
      "APP_ORIGIN not set — invite/email deep links may be relative paths only",
    );
  }
  warnings.push(
    "TEMPORARY SECURITY EXCEPTION: App Check is not enforced on callables yet. Enable after reCAPTCHA keys are configured (see docs/APP_CHECK.md).",
  );

  return {
    readyForRealClients: blockers.length === 0,
    contentReady: content.ready,
    smtpConfigured: false,
    firebaseEmail: true,
    appOrigin: appOrigin || null,
    blockers,
    warnings,
  };
});
