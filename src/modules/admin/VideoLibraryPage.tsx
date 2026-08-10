import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  connectStorageEmulator,
  getStorage,
  ref,
  uploadBytesResumable,
} from "firebase/storage";
import { httpsCallable, type FunctionsError } from "firebase/functions";
import {
  MAX_VIDEO_UPLOAD_SIZE,
  MAX_VIDEO_UPLOAD_SIZE_LABEL,
  PERMISSIONS,
  VIDEO_STATUS,
  type VideoAsset,
} from "@spp/shared";
import { app, functions } from "@/lib/firebase";
import { useAuth } from "@/modules/auth/AuthProvider";
import { StaffNav } from "@/components/StaffNav";
import { formatDateTime } from "@/lib/format";
import "./videoLibrary.css";

const storage = getStorage(app);
if (import.meta.env.VITE_USE_EMULATORS === "true") {
  connectStorageEmulator(storage, "127.0.0.1", 9199);
}

type VideoRow = VideoAsset & { id: string };

interface UploadProgressState {
  percent: number;
  bytesTransferred: number;
  totalBytes: number;
  phase: "uploading" | "finalizing";
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

function mapUploadError(err: unknown): string {
  if (!err || typeof err !== "object") return "Upload failed.";
  const anyErr = err as FunctionsError & { message?: string; code?: string };
  const code = String(anyErr.code || "").toLowerCase();
  const message = String(anyErr.message || "").trim();
  if (code.includes("deadline-exceeded") || message.toLowerCase().includes("timeout")) {
    return "The request timed out while finalizing. Use Retry Finalization — the file is already uploaded.";
  }
  if (message.toLowerCase().includes("storage before finalizing")) {
    return "Storage upload is still settling. Wait a moment and use Retry Finalization.";
  }
  if (message) return message.replace(/^Firebase:\s*/i, "").replace(/\s*\(.*\)$/, "");
  return "Upload failed.";
}

/** True when Storage may exist but Firestore fileSize was never written. */
function needsFinalization(v: VideoRow): boolean {
  return (
    Boolean(v.storagePath) &&
    v.fileSize == null &&
    v.status !== VIDEO_STATUS.DELETED &&
    v.deleted !== true
  );
}

function canActivate(v: VideoRow): boolean {
  return (
    v.fileSize != null &&
    Boolean(v.storagePath) &&
    v.status !== VIDEO_STATUS.DELETED &&
    v.deleted !== true &&
    v.status !== VIDEO_STATUS.ARCHIVED
  );
}

export function VideoLibraryPage() {
  const { hasPermission, companyId: claimCompanyId } = useAuth();
  const canManage = hasPermission(PERMISSIONS.VIDEOS_MANAGE);
  const [videos, setVideos] = useState<VideoRow[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [maxBytes, setMaxBytes] = useState(MAX_VIDEO_UPLOAD_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] =
    useState<UploadProgressState | null>(null);
  const [pendingFinalizeId, setPendingFinalizeId] = useState<string | null>(null);
  const [title, setTitle] = useState("Sales Presentation");
  const [description, setDescription] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const callable = httpsCallable(functions, "listVideos");
      const result = await callable(
        claimCompanyId ? { companyId: claimCompanyId } : {},
      );
      const data = result.data as {
        videos: VideoRow[];
        companyId: string;
        maxUploadBytes: number;
      };
      setVideos(data.videos || []);
      setCompanyId(data.companyId || "");
      if (data.maxUploadBytes) setMaxBytes(data.maxUploadBytes);
    } catch (err) {
      setError(mapUploadError(err) || "Unable to load videos.");
    } finally {
      setLoading(false);
    }
  }, [claimCompanyId]);

  useEffect(() => {
    if (canManage) void refresh();
  }, [canManage, refresh]);

  async function runAction(
    videoId: string,
    name: string,
    data: Record<string, unknown> = {},
  ) {
    setBusyId(videoId);
    setError(null);
    setMessage(null);
    try {
      const callable = httpsCallable(functions, name);
      await callable({ videoId, ...data });
      setMessage("Action completed.");
      await refresh();
    } catch (err) {
      setError(mapUploadError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function finalizeDraft(
    videoId: string,
    durationSeconds: number | null = null,
  ): Promise<void> {
    console.info("[video-upload] finalize_start", { videoId, durationSeconds });
    const finalize = httpsCallable(functions, "finalizeVideoUpload");
    const result = await finalize({ videoId, durationSeconds });
    console.info("[video-upload] finalize_ok", result.data);
  }

  async function retryFinalization(videoId: string) {
    setBusyId(videoId);
    setError(null);
    setMessage(null);
    setUploadProgress({
      percent: 100,
      bytesTransferred: 0,
      totalBytes: 0,
      phase: "finalizing",
    });
    try {
      await finalizeDraft(videoId, null);
      setPendingFinalizeId(null);
      setMessage("Upload finalized. You can Activate this video now.");
      await refresh();
    } catch (err) {
      console.error("[video-upload] finalize_retry_failed", err);
      setPendingFinalizeId(videoId);
      setError(mapUploadError(err));
    } finally {
      setBusyId(null);
      setUploadProgress(null);
    }
  }

  async function onUpload(e: FormEvent) {
    e.preventDefault();
    if (!canManage) return;
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose an MP4 file to upload.");
      return;
    }
    if (!file.type.startsWith("video/")) {
      setError("Only video files are allowed.");
      return;
    }
    const compatible =
      file.type === "video/mp4" ||
      file.name.toLowerCase().endsWith(".mp4");
    if (!compatible) {
      const proceed = window.confirm(
        "This file may not play on all devices (especially Safari/iOS).\n\nRecommended format: MP4 with H.264 video and AAC audio.\n\nUpload anyway?",
      );
      if (!proceed) return;
    }
    if (file.size > maxBytes) {
      setError(
        `File exceeds maximum upload size: ${MAX_VIDEO_UPLOAD_SIZE_LABEL}.`,
      );
      return;
    }

    setError(null);
    setMessage(null);
    setPendingFinalizeId(null);
    setUploadProgress({
      percent: 0,
      bytesTransferred: 0,
      totalBytes: file.size,
      phase: "uploading",
    });
    setBusyId("upload");

    let draftId: string | null = null;

    try {
      console.info("[video-upload] draft_create_start", {
        title,
        size: file.size,
        type: file.type,
      });
      const create = httpsCallable(functions, "createVideoDraft");
      const created = await create({ title, description });
      const draft = created.data as { id: string; storagePath: string };
      draftId = draft.id;
      setPendingFinalizeId(draft.id);
      console.info("[video-upload] draft_create_ok", draft);

      const storageRef = ref(storage, draft.storagePath);
      console.info("[video-upload] storage_upload_start", {
        storagePath: draft.storagePath,
      });
      await new Promise<void>((resolve, reject) => {
        const task = uploadBytesResumable(storageRef, file, {
          contentType: file.type || "video/mp4",
        });
        task.on(
          "state_changed",
          (snap) => {
            setUploadProgress({
              percent: Math.round(
                (snap.bytesTransferred / snap.totalBytes) * 100,
              ),
              bytesTransferred: snap.bytesTransferred,
              totalBytes: snap.totalBytes,
              phase: "uploading",
            });
          },
          (uploadErr) => {
            console.error("[video-upload] storage_upload_failed", uploadErr);
            reject(uploadErr);
          },
          () => {
            console.info("[video-upload] storage_upload_ok", {
              videoId: draft.id,
            });
            resolve();
          },
        );
      });

      // CRITICAL: finalize immediately after Storage completes.
      // Do NOT block on client-side duration probing for large files.
      setUploadProgress((prev) =>
        prev
          ? { ...prev, percent: 100, phase: "finalizing" }
          : {
              percent: 100,
              bytesTransferred: file.size,
              totalBytes: file.size,
              phase: "finalizing",
            },
      );
      setMessage("Finalizing upload…");
      await finalizeDraft(draft.id, null);
      setPendingFinalizeId(null);

      // Best-effort duration — never blocks activation.
      void readDurationWithTimeout(file, 8_000)
        .then(async (durationSeconds) => {
          try {
            await finalizeDraft(draft.id, durationSeconds);
            await refresh();
          } catch {
            // Already finalized; duration update is optional.
          }
        })
        .catch(() => {
          console.info("[video-upload] duration_skip", { videoId: draft.id });
        });

      setMessage("Video uploaded and finalized. You can Activate it now.");
      setTitle("Sales Presentation");
      setDescription("");
      if (fileRef.current) fileRef.current.value = "";
      await refresh();
    } catch (err) {
      console.error("[video-upload] failed", { draftId, err });
      if (draftId) setPendingFinalizeId(draftId);
      setError(
        draftId
          ? `${mapUploadError(err)} The file may already be in Storage — use Retry Finalization.`
          : mapUploadError(err),
      );
      await refresh();
    } finally {
      setBusyId(null);
      setUploadProgress(null);
    }
  }

  async function preview(videoId: string) {
    setBusyId(videoId);
    setError(null);
    try {
      const callable = httpsCallable(functions, "getAdminVideoPreviewUrl");
      const result = await callable({ videoId });
      const data = result.data as { videoUrl: string };
      setPreviewUrl(data.videoUrl);
    } catch (err) {
      setError(mapUploadError(err));
    } finally {
      setBusyId(null);
    }
  }

  if (!canManage) {
    return (
      <div className="app-shell">
        <p>
          <Link to="/app">← Back to dashboard</Link>
        </p>
        <div className="panel">
          <h1>Video Library</h1>
          <p className="muted">
            Administrator permission required (`videos:manage`).
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>Video Library</h1>
          <p className="muted">
            Company: {companyId || "—"} · Only one Active video at a time
          </p>
        </div>
        <StaffNav />
      </header>

      <section className="panel">
        <h2>Upload video</h2>
        <form className="stack-form" onSubmit={(e) => void onUpload(e)}>
          <label>
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </label>
          <label>
            Description
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label>
            MP4 file
            <input ref={fileRef} type="file" accept="video/mp4,video/*" required />
          </label>
          <p className="muted small">
            Maximum upload size: {MAX_VIDEO_UPLOAD_SIZE_LABEL}. Prefer{" "}
            <strong>MP4 (H.264 + AAC)</strong> for widest desktop and mobile
            compatibility (Safari/iOS included). Clients never browse this
            library — access is invitation + legal acceptance + signed URL only.
          </p>
          {uploadProgress != null ? (
            <div className="video-upload-progress" aria-live="polite">
              <div className="video-upload-progress-meta">
                <span>
                  {uploadProgress.phase === "finalizing"
                    ? "Finalizing upload…"
                    : `Uploading… ${uploadProgress.percent}%`}
                </span>
                {uploadProgress.totalBytes > 0 ? (
                  <span className="muted small">
                    {formatBytes(uploadProgress.bytesTransferred)} /{" "}
                    {formatBytes(uploadProgress.totalBytes)}
                  </span>
                ) : null}
              </div>
              <div
                className="video-upload-progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={
                  uploadProgress.phase === "finalizing"
                    ? 100
                    : uploadProgress.percent
                }
              >
                <div
                  className="video-upload-progress-fill"
                  style={{
                    width: `${
                      uploadProgress.phase === "finalizing"
                        ? 100
                        : uploadProgress.percent
                    }%`,
                  }}
                />
              </div>
            </div>
          ) : null}
          <button type="submit" disabled={busyId === "upload"}>
            {busyId === "upload" ? "Uploading…" : "Upload"}
          </button>
        </form>
      </section>

      <section className="panel table-panel">
        <h2>Library</h2>
        {loading ? <p className="muted">Loading…</p> : null}
        {!loading && videos.length === 0 ? (
          <p className="muted">No videos yet. Upload an MP4 to begin.</p>
        ) : null}
        {videos.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Version</th>
                  <th>Company</th>
                  <th>Duration</th>
                  <th>Status</th>
                  <th>Upload date</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {videos.map((v) => {
                  const stuck = needsFinalization(v);
                  return (
                    <tr key={v.id}>
                      <td>
                        <strong>{v.title}</strong>
                        {v.description ? (
                          <div className="muted small">{v.description}</div>
                        ) : null}
                        {stuck ? (
                          <div className="error small">
                            Upload incomplete — finalize required before Activate.
                          </div>
                        ) : null}
                      </td>
                      <td>{v.versionNumber}</td>
                      <td>{v.companyId}</td>
                      <td>
                        {v.durationSeconds != null
                          ? `${Math.round(Number(v.durationSeconds))}s`
                          : "—"}
                      </td>
                      <td>
                        <span className={`video-status video-status-${v.status}`}>
                          {statusLabel(String(v.status))}
                          {stuck ? " · pending finalize" : ""}
                        </span>
                      </td>
                      <td>{formatDateTime(v.uploadDate || v.createdAt)}</td>
                      <td>
                        <div className="video-actions">
                          {stuck ? (
                            <button
                              type="button"
                              disabled={busyId === v.id}
                              onClick={() => void retryFinalization(v.id)}
                            >
                              {busyId === v.id
                                ? "Finalizing…"
                                : "Retry Finalization"}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="ghost"
                            disabled={busyId === v.id || stuck}
                            onClick={() => void preview(v.id)}
                          >
                            Preview
                          </button>
                          {v.status !== VIDEO_STATUS.ACTIVE ? (
                            <button
                              type="button"
                              disabled={
                                busyId === v.id ||
                                v.status === VIDEO_STATUS.DELETED ||
                                !canActivate(v)
                              }
                              onClick={() => void runAction(v.id, "activateVideo")}
                            >
                              Activate
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="ghost"
                              disabled={busyId === v.id}
                              onClick={() =>
                                void runAction(v.id, "deactivateVideo")
                              }
                            >
                              Deactivate
                            </button>
                          )}
                          {v.status !== VIDEO_STATUS.ARCHIVED &&
                          v.status !== VIDEO_STATUS.DELETED ? (
                            <button
                              type="button"
                              className="ghost"
                              disabled={busyId === v.id}
                              onClick={() => void runAction(v.id, "archiveVideo")}
                            >
                              Archive
                            </button>
                          ) : null}
                          {v.status !== VIDEO_STATUS.ACTIVE ? (
                            <button
                              type="button"
                              className="ghost"
                              disabled={busyId === v.id}
                              onClick={() => {
                                if (v.status === VIDEO_STATUS.DELETED) {
                                  if (
                                    !window.confirm(
                                      "Permanently delete this video and its Storage file?",
                                    )
                                  ) {
                                    return;
                                  }
                                  void runAction(v.id, "deleteVideo", {
                                    permanent: true,
                                    confirm: true,
                                  });
                                  return;
                                }
                                if (!window.confirm("Soft-delete this video?"))
                                  return;
                                void runAction(v.id, "deleteVideo");
                              }}
                            >
                              Delete
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {pendingFinalizeId ? (
          <p className="muted small" style={{ marginTop: "0.75rem" }}>
            Pending finalize for video{" "}
            <code>{pendingFinalizeId}</code>. If Activate is disabled, use Retry
            Finalization.
          </p>
        ) : null}
      </section>

      {previewUrl ? (
        <section className="panel">
          <h2>Preview</h2>
          <video className="video-preview" src={previewUrl} controls playsInline />
          <button type="button" className="ghost" onClick={() => setPreviewUrl(null)}>
            Close preview
          </button>
        </section>
      ) : null}

      {message ? <p className="success">{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

function readDurationWithTimeout(file: File, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      reject(new Error("duration timeout"));
    }, timeoutMs);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      const duration = video.duration;
      URL.revokeObjectURL(url);
      if (!Number.isFinite(duration)) reject(new Error("duration unavailable"));
      else resolve(duration);
    };
    video.onerror = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
      reject(new Error("metadata failed"));
    };
    video.src = url;
  });
}
