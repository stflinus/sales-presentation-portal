import { NavLink } from "react-router-dom";
import { PERMISSIONS, ROLE_IDS } from "@spp/shared";
import { useAuth } from "@/modules/auth/AuthProvider";

function linkClass({ isActive }: { isActive: boolean }): string {
  return isActive ? "nav-link active" : "nav-link";
}

/**
 * Role-based staff navigation (v0.1 — no Contacts CRM UI).
 */
export function StaffNav() {
  const { user, hasPermission, rolePrimary, signOut } = useAuth();

  const isAdmin =
    rolePrimary === ROLE_IDS.ADMINISTRATOR || rolePrimary === ROLE_IDS.OWNER;
  const isManager = rolePrimary === ROLE_IDS.MANAGER;
  const canManageVideos = hasPermission(PERMISSIONS.VIDEOS_MANAGE);
  const canManageCompanies = hasPermission(PERMISSIONS.COMPANIES_MANAGE);
  const canManageUsers =
    hasPermission(PERMISSIONS.USERS_MANAGE) ||
    hasPermission(PERMISSIONS.USERS_MANAGE_COMPANY);
  const canManageSettings = hasPermission(PERMISSIONS.SETTINGS_MANAGE);
  const canReadEvidence =
    hasPermission(PERMISSIONS.LEGAL_EVIDENCE_READ_ALL) ||
    hasPermission(PERMISSIONS.LEGAL_EVIDENCE_READ_COMPANY);
  const isLimitedRep = !isAdmin && !isManager;

  return (
    <nav className="staff-nav topbar-actions">
      <NavLink to="/app" end className={linkClass}>
        Dashboard
      </NavLink>

      {isLimitedRep ? (
        <>
          <a className="nav-link" href="/app#invite">
            New Presentation
          </a>
          <a className="nav-link" href="/app#sessions">
            My Sessions
          </a>
          <a className="nav-link" href="/app#follow-ups">
            Follow-Ups
          </a>
        </>
      ) : null}

      {isManager ? (
        <>
          {canManageUsers ? (
            <NavLink to="/app/users" className={linkClass}>
              Representatives
            </NavLink>
          ) : null}
          <a className="nav-link" href="/app#follow-ups">
            Follow-Ups
          </a>
        </>
      ) : null}

      {isAdmin ? (
        <>
          {canManageCompanies ? (
            <NavLink to="/app/companies" className={linkClass}>
              Companies
            </NavLink>
          ) : null}
          {canManageUsers ? (
            <NavLink to="/app/users" className={linkClass}>
              Users
            </NavLink>
          ) : null}
          {canManageVideos ? (
            <NavLink to="/app/videos" className={linkClass}>
              Video Library
            </NavLink>
          ) : null}
          {canReadEvidence ? (
            <NavLink to="/app/legal-evidence" className={linkClass}>
              Legal Evidence
            </NavLink>
          ) : null}
          {canManageSettings ? (
            <NavLink to="/app/settings" className={linkClass}>
              Notification Settings
            </NavLink>
          ) : null}
        </>
      ) : null}

      {!isAdmin && !isManager && canManageVideos ? (
        <NavLink to="/app/videos" className={linkClass}>
          Video Library
        </NavLink>
      ) : null}

      <span className="muted small">{user?.email}</span>
      <button type="button" className="ghost" onClick={() => signOut()}>
        Sign out
      </button>
    </nav>
  );
}
