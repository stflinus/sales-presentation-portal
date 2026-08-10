import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { PERMISSIONS } from "@spp/shared";
import { useAuth } from "@/modules/auth/AuthProvider";

/**
 * Company email page — SMTP removed. Redirects to Notification Settings
 * (Firebase Trigger Email).
 */
export function CompanyEmailPage() {
  const { companyId: routeCompanyId } = useParams();
  const [searchParams] = useSearchParams();
  const companyId =
    routeCompanyId || searchParams.get("companyId") || "serenity-1";
  const { hasPermission, isPlatformAdmin, loading: authLoading } = useAuth();
  const canManage =
    isPlatformAdmin || hasPermission(PERMISSIONS.COMPANIES_MANAGE);

  if (authLoading) return <p className="muted">Loading…</p>;
  if (!canManage) {
    return <Navigate to="/app" replace />;
  }

  return <Navigate to="/app/settings" replace state={{ companyId }} />;
}
