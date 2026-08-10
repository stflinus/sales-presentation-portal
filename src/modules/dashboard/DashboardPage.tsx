import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { httpsCallable } from "firebase/functions";
import {
  FOLLOWUP_STATUS,
  PERMISSIONS,
  ROLE_IDS,
  type PresentationSession,
} from "@spp/shared";
import { formatDateTime } from "@/lib/format";
import { functions } from "@/lib/firebase";
import { staffFriendlyError } from "@/lib/staffErrors";
import { useAuth } from "@/modules/auth/AuthProvider";
import { StaffNav } from "@/components/StaffNav";
import { PresentationStatusBadges } from "@/components/StatusBadge";
import { InviteClientForm } from "@/modules/invites/InviteClientForm";
import { InternalCalendarPanel } from "@/modules/calendar/InternalCalendarPanel";
import { useDashboardSessions } from "./useSessions";
import {
  PresentationHealthIndicator,
  PresentationHealthPanel,
} from "./PresentationHealthPanel";
import {
  computeDashboardStats,
  followUpBucket,
  matchesStatusFilter,
  uniquePresentations,
  type DashboardStatusFilter,
} from "./dashboardStats";

function roleTitle(rolePrimary: string | null): string {
  if (rolePrimary === ROLE_IDS.ADMINISTRATOR || rolePrimary === ROLE_IDS.OWNER) {
    return "Platform Administrator";
  }
  if (rolePrimary === ROLE_IDS.MANAGER) return "Company Manager";
  return "Representative";
}

function followUpStatusLabel(s: PresentationSession): string {
  if (s.followUpStatus === FOLLOWUP_STATUS.COMPLETED) return "Completed";
  const bucket = followUpBucket(s.followUpAt);
  if (bucket === "overdue") return "Overdue";
  if (bucket === "today") return "Today";
  if (bucket === "tomorrow" || bucket === "future") return "Upcoming";
  return s.followUpStatus || "—";
}

function followUpDatePart(s: PresentationSession): string {
  if (s.followUpDate) return s.followUpDate;
  if (!s.followUpAt) return "—";
  const d = new Date(s.followUpAt);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function followUpTimePart(s: PresentationSession): string {
  if (s.followUpTime) return s.followUpTime;
  if (!s.followUpAt) return "—";
  const d = new Date(s.followUpAt);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function DashboardPage() {
  const {
    user,
    rolePrimary,
    hasPermission,
    isPlatformAdmin,
    companyId,
  } = useAuth();
  const { sessions: rawSessions, loading, error } = useDashboardSessions();
  const sessions = useMemo(
    () => uniquePresentations(rawSessions),
    [rawSessions],
  );
  const showRepFilter =
    isPlatformAdmin || hasPermission(PERMISSIONS.SESSIONS_READ_COMPANY);
  const canCreateInvite = hasPermission(PERMISSIONS.INVITES_CREATE);

  const [statusFilter, setStatusFilter] =
    useState<DashboardStatusFilter>("all");
  const [repFilter, setRepFilter] = useState("");
  const [companyFilter, setCompanyFilter] = useState("");
  const [companyNames, setCompanyNames] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<PresentationSession | null>(
    null,
  );
  const [activityTarget, setActivityTarget] =
    useState<PresentationSession | null>(null);
  const [deleteText, setDeleteText] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (!isPlatformAdmin) return;
    void (async () => {
      try {
        const callable = httpsCallable(functions, "listCompanies");
        const result = await callable({});
        const data = result.data as {
          companies: Array<{ id: string; name: string }>;
        };
        const map: Record<string, string> = {};
        for (const c of data.companies || []) map[c.id] = c.name;
        setCompanyNames(map);
      } catch {
        // optional
      }
    })();
  }, [isPlatformAdmin]);

  const representatives = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions) {
      map.set(s.representativeId, s.representativeName);
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [sessions]);

  const companies = useMemo(() => {
    const ids = new Set(sessions.map((s) => s.companyId).filter(Boolean));
    return [...ids].sort();
  }, [sessions]);

  const filtered = useMemo(() => {
    return sessions.filter((s) => {
      if (!matchesStatusFilter(s, statusFilter)) return false;
      if (repFilter && s.representativeId !== repFilter) return false;
      if (companyFilter && s.companyId !== companyFilter) return false;
      return true;
    });
  }, [sessions, statusFilter, repFilter, companyFilter]);

  const stats = useMemo(() => computeDashboardStats(sessions), [sessions]);

  const todaysFollowUps = useMemo(() => {
    return sessions
      .filter(
        (s) =>
          s.followUpStatus === FOLLOWUP_STATUS.SCHEDULED &&
          followUpBucket(s.followUpAt) === "today",
      )
      .sort(
        (a, b) =>
          new Date(a.followUpAt || 0).getTime() -
          new Date(b.followUpAt || 0).getTime(),
      );
  }, [sessions]);

  const recentActivity = useMemo(() => {
    return [...sessions]
      .sort((a, b) => {
        const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return tb - ta;
      })
      .slice(0, 8);
  }, [sessions]);

  async function confirmDelete() {
    if (!deleteTarget || deleteText !== "DELETE") return;
    setDeleteBusy(true);
    setActionError(null);
    try {
      const callable = httpsCallable(functions, "deletePresentation");
      await callable({ sessionId: deleteTarget.id, confirm: "DELETE" });
      setActionMessage("Presentation deleted. Legal evidence preserved.");
      setDeleteTarget(null);
      setDeleteText("");
    } catch (err) {
      setActionError(staffFriendlyError(err, "Delete failed. Please try again."));
    } finally {
      setDeleteBusy(false);
    }
  }

  function canCopyInviteLink(s: PresentationSession): boolean {
    if (!s.inviteUrl) return false;
    if (isPlatformAdmin) return true;
    if (user && s.representativeId === user.uid) return true;
    if (
      hasPermission(PERMISSIONS.SESSIONS_READ_COMPANY) &&
      companyId &&
      s.companyId === companyId
    ) {
      return true;
    }
    return false;
  }

  async function copyInviteLink(s: PresentationSession) {
    if (!canCopyInviteLink(s) || !s.inviteUrl) {
      setActionError("Invitation link is not available for this Presentation.");
      return;
    }
    setActionError(null);
    try {
      await navigator.clipboard.writeText(s.inviteUrl);
      setCopiedSessionId(s.id);
      setActionMessage("✓ Invitation link copied.");
    } catch {
      setActionError("Unable to copy link. Try again or open the Presentation.");
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Presentation Hub · Version 0.1</p>
          <h1>{roleTitle(rolePrimary)}</h1>
        </div>
        <StaffNav />
      </header>

      <section className="stat-grid" aria-label="Today's statistics">
        <div className="stat-card tone-neutral">
          <span className="stat-label">Active Presentations</span>
          <strong>{sessions.length}</strong>
        </div>
        <div className="stat-card tone-pending">
          <span className="stat-label">Pending</span>
          <strong>{stats.pending}</strong>
        </div>
        <div className="stat-card tone-today">
          <span className="stat-label">Today&apos;s Follow-Ups</span>
          <strong>{stats.followUpsDueToday}</strong>
        </div>
        <div className="stat-card tone-completed">
          <span className="stat-label">Completed</span>
          <strong>{stats.completed}</strong>
        </div>
        <div className="stat-card tone-won">
          <span className="stat-label">Won</span>
          <strong>{stats.won}</strong>
        </div>
        <div className="stat-card tone-lost">
          <span className="stat-label">Lost</span>
          <strong>{stats.lost}</strong>
        </div>
      </section>

      {canCreateInvite ? (
        <div className="dashboard-grid">
          <InviteClientForm />
        </div>
      ) : null}

      <section className="panel" id="todays-follow-ups">
        <div className="section-head">
          <div>
            <h2>Today&apos;s Follow-Ups</h2>
            <p className="muted small" style={{ margin: 0 }}>
              One row per Presentation — no duplicates
            </p>
          </div>
        </div>
        {todaysFollowUps.length === 0 ? (
          <div className="empty-state">
            <p>No follow-ups scheduled for today.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Date</th>
                  <th>Time</th>
                  <th>Status</th>
                  <th>Open</th>
                </tr>
              </thead>
              <tbody>
                {todaysFollowUps.map((s) => (
                  <tr key={s.id}>
                    <td>{s.clientName}</td>
                    <td>{followUpDatePart(s)}</td>
                    <td>{followUpTimePart(s)}</td>
                    <td>{followUpStatusLabel(s)}</td>
                    <td>
                      <Link to={`/app/sessions/${s.id}`}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" id="calendar">
        <InternalCalendarPanel sessions={sessions} />
      </section>

      <section className="panel" id="recent-activity">
        <div className="section-head">
          <h2>Recent Activity</h2>
        </div>
        {recentActivity.length === 0 ? (
          <div className="empty-state">
            <p>No recent activity.</p>
          </div>
        ) : (
          <ul className="agenda-list">
            {recentActivity.map((s) => (
              <li key={s.id}>
                <Link to={`/app/sessions/${s.id}`}>
                  <strong>{s.clientName}</strong>
                  <span className="muted small">
                    {" "}
                    · {s.representativeName} ·{" "}
                    {formatDateTime(s.updatedAt || s.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel table-panel" id="sessions">
        <div className="section-head">
          <h2>Active Presentations</h2>
          <p className="muted">
            One row per Presentation. Follow-up updates the same record.
          </p>
        </div>

        <div className="filter-bar">
          <div className="filter-fields">
            {isPlatformAdmin ? (
              <label>
                Company
                <select
                  value={companyFilter}
                  onChange={(e) => setCompanyFilter(e.target.value)}
                >
                  <option value="">All companies</option>
                  {companies.map((id) => (
                    <option key={id} value={id}>
                      {companyNames[id] || id}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {showRepFilter ? (
              <label>
                Representative
                <select
                  value={repFilter}
                  onChange={(e) => setRepFilter(e.target.value)}
                >
                  <option value="">All representatives</option>
                  {representatives.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              Status
              <select
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as DashboardStatusFilter)
                }
              >
                <option value="all">All</option>
                <option value="pending">Pending</option>
                <option value="opened">Opened</option>
                <option value="legal_accepted">Legal Accepted</option>
                <option value="started">Started</option>
                <option value="completed">Completed</option>
                <option value="won">Won</option>
                <option value="lost">Lost</option>
              </select>
            </label>
          </div>
        </div>

        {loading ? <p className="muted">Loading presentations…</p> : null}
        {error ? <p className="error">{error}</p> : null}
        {actionError ? <p className="error">{actionError}</p> : null}
        {actionMessage ? <p className="success">{actionMessage}</p> : null}

        {!loading && sessions.length === 0 ? (
          <div className="empty-state">
            <p>No presentations yet.</p>
            <p className="muted">Create your first presentation to begin.</p>
          </div>
        ) : null}

        {!loading && sessions.length > 0 && filtered.length === 0 ? (
          <div className="empty-state">
            <p>No presentations match these filters.</p>
            <button
              type="button"
              className="ghost"
              onClick={() => setStatusFilter("all")}
            >
              Show all
            </button>
          </div>
        ) : null}

        {filtered.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Health</th>
                  <th>Client</th>
                  <th>Representative</th>
                  <th>Status</th>
                  <th>Follow-Up Date</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <PresentationHealthIndicator
                        status={s.healthStatus}
                        summary={s.healthSummary}
                        onClick={() => setActivityTarget(s)}
                      />
                    </td>
                    <td>
                      <div>{s.clientName}</div>
                      <div className="muted small">{s.clientEmail}</div>
                    </td>
                    <td>{s.representativeName}</td>
                    <td>
                      <PresentationStatusBadges session={s} />
                    </td>
                    <td>
                      {s.followUpAt ? formatDateTime(s.followUpAt) : "—"}
                    </td>
                    <td className="actions-cell">
                      <Link to={`/app/sessions/${s.id}`}>Open</Link>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => setActivityTarget(s)}
                      >
                        Activity
                      </button>
                      {canCopyInviteLink(s) ? (
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => void copyInviteLink(s)}
                        >
                          {copiedSessionId === s.id ? "Copied" : "Copy Link"}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => {
                          setDeleteTarget(s);
                          setDeleteText("");
                          setActionError(null);
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {!isPlatformAdmin && companyId ? (
          <p className="muted small">Company scope: {companyId}</p>
        ) : null}
      </section>

      {deleteTarget ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="panel modal-panel">
            <h2>Delete Presentation?</h2>
            <p>
              This permanently removes the Presentation, Follow-Up, Invitation,
              Operational Notes, and Calendar Appointment.
            </p>
            <p>Legal evidence and immutable audit records will be preserved.</p>
            <p>
              Client: <strong>{deleteTarget.clientName}</strong> (
              {deleteTarget.clientEmail})
            </p>
            <p>Type DELETE to confirm.</p>
            <label>
              Confirmation
              <input
                value={deleteText}
                onChange={(e) => setDeleteText(e.target.value)}
                placeholder="DELETE"
                autoComplete="off"
                disabled={deleteBusy}
              />
            </label>
            <div className="topbar-actions">
              <button
                type="button"
                className="ghost"
                disabled={deleteBusy}
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteText("");
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleteBusy || deleteText !== "DELETE"}
                onClick={() => void confirmDelete()}
              >
                {deleteBusy ? "Deleting…" : "Delete Presentation"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {activityTarget ? (
        <PresentationHealthPanel
          sessionId={activityTarget.id}
          clientName={activityTarget.clientName}
          onClose={() => setActivityTarget(null)}
        />
      ) : null}
    </div>
  );
}
