import { useCallback, useEffect, useMemo, useState } from "react";
import { httpsCallable } from "firebase/functions";
import {
  ACTIVITY_EVENT_LABEL,
  ACTIVITY_SEVERITY,
  APP_VERSION,
  PRESENTATION_HEALTH,
} from "@spp/shared";
import { functions } from "@/lib/firebase";
import { formatDateTime } from "@/lib/format";
import { staffFriendlyError } from "@/lib/staffErrors";
import { useAuth } from "@/modules/auth/AuthProvider";

export interface HealthEvent {
  id: string;
  type: string;
  severity: string;
  title: string;
  description: string;
  createdAt: string | null;
  inviteId?: string | null;
  diagnostics?: {
    errorSummary?: string | null;
    errorCode?: string | null;
    exceptionType?: string | null;
    cloudFunction?: string | null;
    firestoreCollection?: string | null;
    documentId?: string | null;
    storageObject?: string | null;
    browser?: string | null;
    browserVersion?: string | null;
    deviceType?: string | null;
    operatingSystem?: string | null;
    screenResolution?: string | null;
    networkStatus?: string | null;
    correlationId?: string | null;
    stackTrace?: string | null;
    recommendedAction?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    appVersion?: string | null;
  } | null;
}

interface HealthResponse {
  sessionId: string;
  inviteId: string | null;
  clientName: string | null;
  clientEmail: string | null;
  representativeName: string | null;
  status: string | null;
  diagnostics: boolean;
  healthStatus: string;
  healthSummary: string;
  empty: boolean;
  emptyMessage: string;
  appVersion: string;
  events: HealthEvent[];
}

interface Props {
  sessionId: string;
  clientName?: string;
  onClose: () => void;
}

function severityClass(severity: string): string {
  if (severity === ACTIVITY_SEVERITY.SUCCESS) return "activity-sev-success";
  if (severity === ACTIVITY_SEVERITY.WARNING) return "activity-sev-warning";
  if (severity === ACTIVITY_SEVERITY.ERROR) return "activity-sev-error";
  return "activity-sev-info";
}

function healthLabel(status: string): { emoji: string; text: string } {
  if (status === PRESENTATION_HEALTH.ERROR) {
    return { emoji: "🔴", text: "Error" };
  }
  if (status === PRESENTATION_HEALTH.WARNING) {
    return { emoji: "🟡", text: "Warning" };
  }
  return { emoji: "🟢", text: "Healthy" };
}

function downloadBase64(fileName: string, contentBase64: string, mime: string) {
  const bin = atob(contentBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function PresentationHealthPanel({
  sessionId,
  clientName,
  onClose,
}: Props) {
  const { isPlatformAdmin } = useAuth();
  const [data, setData] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exportBusy, setExportBusy] = useState<"pdf" | "json" | null>(null);
  const [copied, setCopied] = useState(false);
  const [stackOpen, setStackOpen] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const callable = httpsCallable(functions, "getPresentationActivityLog");
      const result = await callable({ sessionId });
      setData(result.data as HealthResponse);
    } catch (err) {
      setError(staffFriendlyError(err, "Unable to load presentation health."));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const showDiagnostics = Boolean(data?.diagnostics && isPlatformAdmin);
  const health = healthLabel(data?.healthStatus || PRESENTATION_HEALTH.HEALTHY);

  const latestIssue = useMemo(() => {
    if (!data?.events?.length) return null;
    return [...data.events]
      .reverse()
      .find(
        (e) =>
          e.severity === ACTIVITY_SEVERITY.ERROR ||
          e.severity === ACTIVITY_SEVERITY.WARNING,
      );
  }, [data]);

  async function exportLog(format: "pdf" | "json") {
    setExportBusy(format);
    setError(null);
    try {
      const callable = httpsCallable(functions, "exportPresentationActivityLog");
      const result = await callable({ sessionId, format });
      const payload = result.data as {
        fileName: string;
        contentBase64: string;
      };
      downloadBase64(
        payload.fileName,
        payload.contentBase64,
        format === "pdf" ? "application/pdf" : "application/json",
      );
    } catch (err) {
      setError(staffFriendlyError(err, "Export failed. Please try again."));
    } finally {
      setExportBusy(null);
    }
  }

  async function copyDiagnostics() {
    if (!data || !showDiagnostics) return;
    const d = latestIssue?.diagnostics;
    const report = [
      "Presentation Health — Support Diagnostics",
      `Presentation ID: ${data.sessionId}`,
      `Invitation ID: ${data.inviteId || "—"}`,
      `Timestamp: ${new Date().toISOString()}`,
      `Environment: production`,
      `Application Version: ${data.appVersion || APP_VERSION}`,
      `Client: ${data.clientName || "—"} <${data.clientEmail || ""}>`,
      `Representative: ${data.representativeName || "—"}`,
      `Health: ${health.text}`,
      `Summary: ${data.healthSummary || "—"}`,
      "",
      `Browser: ${d?.browser || "—"} ${d?.browserVersion || ""}`.trim(),
      `Device: ${d?.deviceType || "—"}`,
      `OS: ${d?.operatingSystem || "—"}`,
      `Cloud Function: ${d?.cloudFunction || "—"}`,
      `Error Code: ${d?.errorCode || "—"}`,
      `Exception: ${d?.exceptionType || "—"}`,
      `Correlation ID: ${d?.correlationId || "—"}`,
      `Suggested Resolution: ${d?.recommendedAction || "—"}`,
      "",
      `Error Summary: ${d?.errorSummary || latestIssue?.description || "—"}`,
    ].join("\n");

    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Unable to copy diagnostics to the clipboard.");
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="panel modal-panel activity-log-modal">
        <div className="activity-log-header">
          <div>
            <p className="eyebrow">Presentation Health</p>
            <h2>{clientName || data?.clientName || "Presentation"}</h2>
            <p className="muted small">
              {showDiagnostics
                ? "Administrator support diagnostics"
                : "Presentation activity timeline"}
            </p>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {!loading && data ? (
          <div className={`health-banner health-${data.healthStatus || "healthy"}`}>
            <p className="eyebrow">Presentation Status</p>
            <h3>
              {health.emoji} {health.text}
            </h3>
            <p>
              {data.empty
                ? data.emptyMessage ||
                  "No activity has been recorded for this presentation."
                : data.healthStatus === PRESENTATION_HEALTH.HEALTHY
                  ? "No issues detected."
                  : data.healthSummary}
            </p>
          </div>
        ) : null}

        <div className="activity-log-actions">
          {showDiagnostics ? (
            <button
              type="button"
              className="ghost"
              disabled={!data || loading}
              onClick={() => void copyDiagnostics()}
            >
              {copied ? "Copied" : "Copy Diagnostics"}
            </button>
          ) : null}
          <button
            type="button"
            className="ghost"
            disabled={!!exportBusy || loading}
            onClick={() => void exportLog("pdf")}
          >
            {exportBusy === "pdf" ? "Exporting…" : "Download PDF"}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!!exportBusy || loading}
            onClick={() => void exportLog("json")}
          >
            {exportBusy === "json" ? "Exporting…" : "Download JSON"}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={loading}
            onClick={() => void load()}
          >
            Refresh
          </button>
        </div>

        {loading ? <p className="muted">Loading presentation health…</p> : null}
        {error ? <p className="error">{error}</p> : null}

        {!loading && data && data.empty ? (
          <div className="empty-state">
            <p>No activity has been recorded for this presentation.</p>
          </div>
        ) : null}

        {!loading && data && !data.empty ? (
          <ol className="activity-timeline">
            {data.events.map((e) => {
              const label =
                e.title ||
                ACTIVITY_EVENT_LABEL[e.type] ||
                e.type.replaceAll("_", " ");
              const isIssue =
                e.severity === ACTIVITY_SEVERITY.ERROR ||
                e.severity === ACTIVITY_SEVERITY.WARNING;
              const d = e.diagnostics;
              return (
                <li
                  key={e.id}
                  className={`activity-item ${severityClass(e.severity)}`}
                >
                  <div className="activity-dot" aria-hidden />
                  <div className="activity-body">
                    <div className="activity-meta">
                      <time dateTime={e.createdAt || undefined}>
                        {formatDateTime(e.createdAt)}
                      </time>
                      <span className="activity-sev-label">{e.severity}</span>
                    </div>
                    <h3>{label}</h3>
                    <p>{e.description}</p>

                    {showDiagnostics && isIssue && d ? (
                      <div className="health-error-block">
                        <h4>Error Details</h4>
                        <dl className="activity-diagnostics">
                          <div>
                            <dt>Error Summary</dt>
                            <dd>{d.errorSummary || e.description}</dd>
                          </div>
                          <div>
                            <dt>Error Code</dt>
                            <dd>{d.errorCode || "—"}</dd>
                          </div>
                          <div>
                            <dt>Exception Type</dt>
                            <dd>{d.exceptionType || "—"}</dd>
                          </div>
                          <div>
                            <dt>Cloud Function</dt>
                            <dd>{d.cloudFunction || "—"}</dd>
                          </div>
                          <div>
                            <dt>Firestore Collection</dt>
                            <dd>{d.firestoreCollection || "—"}</dd>
                          </div>
                          <div>
                            <dt>Document ID</dt>
                            <dd>{d.documentId || "—"}</dd>
                          </div>
                          <div>
                            <dt>Storage Object</dt>
                            <dd>{d.storageObject || "—"}</dd>
                          </div>
                          <div>
                            <dt>Browser</dt>
                            <dd>
                              {d.browser || "—"}
                              {d.browserVersion ? ` ${d.browserVersion}` : ""}
                            </dd>
                          </div>
                          <div>
                            <dt>Device</dt>
                            <dd>{d.deviceType || "—"}</dd>
                          </div>
                          <div>
                            <dt>Operating System</dt>
                            <dd>{d.operatingSystem || "—"}</dd>
                          </div>
                          <div>
                            <dt>Screen Resolution</dt>
                            <dd>{d.screenResolution || "—"}</dd>
                          </div>
                          <div>
                            <dt>Network Status</dt>
                            <dd>{d.networkStatus || "—"}</dd>
                          </div>
                          <div>
                            <dt>Timestamp</dt>
                            <dd>{formatDateTime(e.createdAt)}</dd>
                          </div>
                          <div>
                            <dt>Correlation / Request ID</dt>
                            <dd>{d.correlationId || "—"}</dd>
                          </div>
                        </dl>
                        {d.recommendedAction ? (
                          <p className="health-recommended">
                            <strong>Recommended Action:</strong>{" "}
                            {d.recommendedAction}
                          </p>
                        ) : null}
                        {d.stackTrace ? (
                          <details
                            open={!!stackOpen[e.id]}
                            onToggle={(ev) =>
                              setStackOpen((prev) => ({
                                ...prev,
                                [e.id]: (ev.target as HTMLDetailsElement).open,
                              }))
                            }
                          >
                            <summary>Stack Trace</summary>
                            <pre className="health-stack">{d.stackTrace}</pre>
                          </details>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : null}
      </div>
    </div>
  );
}

/** Compact dashboard health indicator. */
export function PresentationHealthIndicator({
  status,
  summary,
  onClick,
}: {
  status?: string | null;
  summary?: string | null;
  onClick?: () => void;
}) {
  const resolved = status || PRESENTATION_HEALTH.HEALTHY;
  const label =
    resolved === PRESENTATION_HEALTH.ERROR
      ? { emoji: "🔴", text: "Needs Attention" }
      : resolved === PRESENTATION_HEALTH.WARNING
        ? { emoji: "🟡", text: "Warning" }
        : { emoji: "🟢", text: "Healthy" };
  const tip =
    summary ||
    (resolved === PRESENTATION_HEALTH.HEALTHY
      ? "No issues detected."
      : label.text);

  return (
    <button
      type="button"
      className={`health-indicator health-indicator-${resolved}`}
      title={tip}
      aria-label={`Presentation health: ${label.text}. ${tip}`}
      onClick={onClick}
    >
      <span aria-hidden>{label.emoji}</span>
      <span className="health-indicator-text">{label.text}</span>
    </button>
  );
}
