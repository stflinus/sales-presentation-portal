import { Navigate, Outlet } from "react-router-dom";
import { PERMISSIONS } from "@spp/shared";
import { useAuth } from "./AuthProvider";

export function RequireStaff() {
  const { user, loading, hasPermission, rolePrimary } = useAuth();

  if (loading) {
    return <div className="page-center muted">Loading…</div>;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (rolePrimary === "client") {
    return <Navigate to="/" replace />;
  }
  if (!hasPermission(PERMISSIONS.DASHBOARD_READ)) {
    return (
      <div className="page-center">
        <div className="panel">
          <h1>Access pending</h1>
          <p className="muted">
            Your account is signed in but has no representative permissions yet.
            An administrator must bootstrap or assign your role.
          </p>
        </div>
      </div>
    );
  }
  return <Outlet />;
}
