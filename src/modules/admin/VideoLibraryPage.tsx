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
  VIDEO_PROCESSING_STATUS,
  formatElapsedLabel,
  formatLastActivityAgo,
  formatMediaClock,
  isVideoProcessingInProgress,
  videoProcessingStatusLabel,
  type VideoAsset,
  type SlideMarker,
  type VideoProcessingHistoryEntry,
} from "@spp/shared";
import { app, functions } from "@/lib/firebase";
import { useAuth } from "@/modules/auth/AuthProvider";
import { StaffNav } from "@/components/StaffNav";
import { formatDateTime } from "@/lib/format";
import "./videoLibrary.css";

type VideoView = "active" | "archived";

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

interface ProcessingDiagRow {
  videoId: string;
  title?: string | null;
  status?: string | null;
  stage?: string | null;
  progressPercent?: number | null;
  processedSeconds?: number | null;
  totalSeconds?: number | null;
  startedAt?: string | null;
  lastProgressAt?: string | null;
  jobId?: string | null;
  attempt?: number | null;
  errorCode?: string | null;
  failureCategory?: string | null;
  ffmpegErrorSummary?: string | null;
  outcome?: string | null;
  updatedAtIso?: string | null;
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
  if (
    message.toUpperCase() === "INTERNAL" ||
    code.includes("internal") ||
    message.toLowerCase().includes("internal")
  ) {
    return "Something went wrong. Please try again or contact support if this continues.";
  }
  if (message.toLowerCase().includes("finalize the upload before activating")) {
    return "Upload is not finalized yet. Use Retry Finalization, then Activate.";
  }
  if (message) return message.replace(/^Firebase:\s*/i, "").replace(/\s*\(.*\)$/, "");
  return "Upload failed.";
}

/** True when Storage may exist but Firestore fileSize was never written. */
function needsFinalization(v: VideoRow): boolean {
  const size = v.fileSize ?? v.sizeBytes;
  return (
    Boolean(v.storagePath) &&
    (size == null || Number(size) <= 0) &&
    v.status !== VIDEO_STATUS.DELETED &&
    v.deleted !== true
  );
}

function canActivate(v: VideoRow): boolean {
  const size = v.fileSize ?? v.sizeBytes;
  return (
    size != null &&
    Number(size) > 0 &&
    Boolean(v.storagePath) &&
    v.status !== VIDEO_STATUS.DELETED &&
    v.deleted !== true &&
    v.status !== VIDEO_STATUS.ARCHIVED
  );
}

/** Check if video needs optimization queue (not in-progress). */
function videoNeedsOptimization(v: VideoRow): boolean {
  const status = v.processing?.status;
  if (isVideoProcessingInProgress(status)) return false;
  if (!status) return true;
  if (status === VIDEO_PROCESSING_STATUS.FAILED) return true;
  if (status === VIDEO_PROCESSING_STATUS.READY) return false;
  if (status === VIDEO_PROCESSING_STATUS.SKIPPED_COMPATIBLE) return false;
  return true;
}

function ProcessingProgressBlock({
  v,
  nowMs,
}: {
  v: VideoRow;
  nowMs: number;
}) {
  const p = v.processing;
  if (!p) return null;
  const status = p.status;
  const isProcessing = isVideoProcessingInProgress(status);
  const isFailed = status === VIDEO_PROCESSING_STATUS.FAILED;
  const isReady =
    status === VIDEO_PROCESSING_STATUS.READY ||
    status === VIDEO_PROCESSING_STATUS.SKIPPED_COMPATIBLE;

  if (!isProcessing && !isFailed && !isReady) return null;

  const label = videoProcessingStatusLabel(status);
  const pct =
    typeof p.progressPercent === "number" && Number.isFinite(p.progressPercent)
      ? Math.max(0, Math.min(100, p.progressPercent))
      : null;
  const indeterminate = isProcessing && pct == null;
  const startedMs = p.startedAt
    ? new Date(p.startedAt).getTime()
    : p.queuedAt
      ? new Date(p.queuedAt).getTime()
      : null;
  const elapsed =
    startedMs != null && Number.isFinite(startedMs)
      ? formatElapsedLabel(nowMs - startedMs)
      : null;
  const lastAgo = formatLastActivityAgo(p.lastProgressAt, nowMs);
  const eta =
    isProcessing &&
    typeof p.estimatedRemainingSeconds === "number" &&
    p.estimatedRemainingSeconds > 0
      ? formatElapsedLabel(p.estimatedRemainingSeconds * 1000)
      : null;

  return (
    <div className="processing-progress-block">
      <div className="processing-progress-title">
        {isProcessing
          ? status === VIDEO_PROCESSING_STATUS.OPTIMIZING
            ? "Optimizing Video"
            : label
          : label}
        {isReady ? " · 100%" : null}
        {isFailed && p.errorCode ? ` · ${p.errorCode}` : null}
      </div>

      {(isProcessing || isReady) && (
        <div
          className={`processing-progress-bar${indeterminate ? " is-indeterminate" : ""}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
          aria-label={indeterminate ? "Processing in progress" : `Processing ${pct}%`}
        >
          <div
            className="processing-progress-fill"
            style={indeterminate ? undefined : { width: `${isReady ? 100 : pct ?? 0}%` }}
          />
        </div>
      )}

      {isProcessing || isFailed ? (
        <div className="processing-progress-meta muted small">
          {pct != null && isProcessing ? <div>{pct}%</div> : null}
          {indeterminate ? <div>Progress: calculating…</div> : null}
          {(p.processedSeconds != null || p.totalSeconds != null) && (
            <div>
              Processed: {formatMediaClock(p.processedSeconds)} /{" "}
              {formatMediaClock(p.totalSeconds)}
            </div>
          )}
          {elapsed ? <div>Elapsed: {elapsed}</div> : null}
          {lastAgo ? <div>Last activity: {lastAgo}</div> : null}
          {eta ? <div>Estimated remaining: ~{eta}</div> : null}
          {p.startedAt ? <div>Started: {formatDateTime(p.startedAt)}</div> : null}
          {p.jobId ? <div>Job: {p.jobId}</div> : null}
          {isFailed && p.failureCategory ? (
            <div>Reason: {String(p.failureCategory).replace(/_/g, " ")}</div>
          ) : null}
          {isFailed && p.failureReason ? (
            <div className="error">
              {String(p.failureReason)
                .replace(/https?:\/\/\S+/gi, "[url]")
                .slice(0, 200)}
            </div>
          ) : null}
        </div>
      ) : null}

      {Array.isArray(p.history) && p.history.length > 0 ? (
        <details className="processing-history">
          <summary className="muted small">Processing history</summary>
          <ol className="processing-history-list">
            {(p.history as VideoProcessingHistoryEntry[]).slice(-10).map((h, i) => (
              <li key={`${h.attempt}-${h.finishedAt || h.startedAt || i}`}>
                Attempt {h.attempt} — {h.outcome}
                {h.failureCategory ? ` — ${h.failureCategory}` : ""}
                {h.note ? ` — ${h.note.slice(0, 80)}` : ""}
                {h.runtime ? ` (${h.runtime})` : ""}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

/** Days remaining until scheduled deletion. */
function daysUntilDeletion(scheduledIso: string | null | undefined): number | null {
  if (!scheduledIso) return null;
  const scheduled = new Date(scheduledIso).getTime();
  const now = Date.now();
  if (scheduled <= now) return 0;
  return Math.ceil((scheduled - now) / (24 * 60 * 60 * 1000));
}

export function VideoLibraryPage() {
  const { hasPermission, companyId: claimCompanyId } = useAuth();
  const canManage = hasPermission(PERMISSIONS.VIDEOS_MANAGE);
  const canPermanentDelete = hasPermission(PERMISSIONS.VIDEOS_PERMANENT_DELETE);
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
  const [renamingVideo, setRenamingVideo] = useState<VideoRow | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameDescription, setRenameDescription] = useState("");
  const [editingSlides, setEditingSlides] = useState<VideoRow | null>(null);
  const [slideMarkers, setSlideMarkers] = useState<SlideMarker[]>([]);
  const [slidesSaving, setSlidesSaving] = useState(false);
  const [currentView, setCurrentView] = useState<VideoView>("active");
  const [bulkOptimizing, setBulkOptimizing] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{
    total: number;
    done: number;
    videoIds: string[];
  } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [diagnostics, setDiagnostics] = useState<ProcessingDiagRow[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const bulkPollRef = useRef<number | null>(null);
  const processingPollRef = useRef<number | null>(null);

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const callable = httpsCallable(functions, "listVideos");
      // Include all non-deleted videos (listVideos already does this)
      const result = await callable(
        claimCompanyId ? { companyId: claimCompanyId, includeDeleted: false } : { includeDeleted: false },
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
      if (!opts?.silent) setError(mapUploadError(err) || "Unable to load videos.");
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [claimCompanyId]);

  const refreshDiagnostics = useCallback(async () => {
    if (!canManage) return;
    try {
      const callable = httpsCallable(functions, "listVideoProcessingDiagnostics");
      const result = await callable({});
      const data = result.data as { latest?: ProcessingDiagRow[] };
      setDiagnostics(Array.isArray(data.latest) ? data.latest.slice(0, 12) : []);
    } catch {
      /* diagnostics are best-effort */
    }
  }, [canManage]);

  // Filter videos by current view
  const filteredVideos = videos.filter((v) => {
    if (currentView === "archived") {
      return v.archived === true || v.status === VIDEO_STATUS.ARCHIVED;
    }
    // Active view: not archived, not deleted
    return v.archived !== true && v.status !== VIDEO_STATUS.ARCHIVED;
  });

  async function optimizeVideo(videoId: string, mode: "optimize" | "reprocess" = "optimize") {
    setBusyId(videoId);
    setError(null);
    setMessage(null);
    try {
      const callable = httpsCallable(functions, "queueVideoProcessing");
      const result = await callable({ videoId, mode });
      const data = result.data as { message?: string };
      setMessage(data.message || "Video queued for processing.");
      await refresh();
    } catch (err) {
      setError(mapUploadError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function restoreVideo(videoId: string) {
    setBusyId(videoId);
    setError(null);
    setMessage(null);
    try {
      const callable = httpsCallable(functions, "restoreVideo");
      await callable({ videoId });
      setMessage("Video restored from archive. You can now activate it.");
      await refresh();
    } catch (err) {
      setError(mapUploadError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function permanentDeleteVideo(videoId: string) {
    setBusyId(videoId);
    setError(null);
    setMessage(null);
    try {
      const callable = httpsCallable(functions, "deleteVideo");
      const result = await callable({ videoId, permanent: true, confirm: true });
      const data = result.data as { ok?: boolean; postponed?: boolean; reason?: string };
      if (data.postponed) {
        setError(`Deletion postponed: ${data.reason || "Active sessions exist."}`);
      } else {
        setMessage("Video permanently deleted.");
      }
      await refresh();
    } catch (err) {
      setError(mapUploadError(err));
    } finally {
      setBusyId(null);
    }
  }

  function stopBulkPoll() {
    if (bulkPollRef.current != null) {
      window.clearInterval(bulkPollRef.current);
      bulkPollRef.current = null;
    }
  }

  async function bulkOptimizeVideos() {
    setBulkOptimizing(true);
    setError(null);
    setMessage(null);
    setBulkProgress(null);
    stopBulkPoll();
    try {
      const callable = httpsCallable(functions, "optimizeExistingVideos");
      const result = await callable(claimCompanyId ? { companyId: claimCompanyId } : {});
      const data = result.data as {
        queued?: number;
        skipped?: number;
        message?: string;
        videoIds?: string[];
      };
      const videoIds = Array.isArray(data.videoIds) ? data.videoIds : [];
      const total = videoIds.length;
      setBulkProgress(total > 0 ? { total, done: 0, videoIds } : null);
      setMessage(
        data.message ||
          (total > 0
            ? `0 of ${total} videos processed`
            : "No videos needed optimization."),
      );
      await refresh();

      if (total === 0) {
        setBulkOptimizing(false);
        return;
      }

      const terminal = new Set<string>([
        VIDEO_PROCESSING_STATUS.READY,
        VIDEO_PROCESSING_STATUS.SKIPPED_COMPATIBLE,
        VIDEO_PROCESSING_STATUS.FAILED,
      ]);

      bulkPollRef.current = window.setInterval(() => {
        void (async () => {
          try {
            const list = httpsCallable(functions, "listVideos");
            const listed = await list(claimCompanyId ? { companyId: claimCompanyId } : {});
            const rows = ((listed.data as { videos?: VideoRow[] }).videos || []) as VideoRow[];
            const tracked = rows.filter((v) => videoIds.includes(v.id));
            const done = tracked.filter((v) =>
              terminal.has(String(v.processing?.status || "")),
            ).length;
            setVideos(rows);
            setBulkProgress({ total, done, videoIds });
            setMessage(`${done} of ${total} videos processed`);
            if (done >= total) {
              stopBulkPoll();
              setBulkOptimizing(false);
              setMessage(`${done} of ${total} videos processed`);
            }
          } catch {
            // Keep polling; transient list failures should not abort the batch.
          }
        })();
      }, 4000);
    } catch (err) {
      setError(mapUploadError(err));
      setBulkOptimizing(false);
      setBulkProgress(null);
    }
  }

  useEffect(() => {
    if (canManage) {
      void refresh();
      void refreshDiagnostics();
    }
  }, [canManage, refresh, refreshDiagnostics]);

  useEffect(() => {
    return () => stopBulkPoll();
  }, []);

  // Auto-refresh backend processing state while any job is active.
  useEffect(() => {
    const anyProcessing = videos.some((v) =>
      isVideoProcessingInProgress(v.processing?.status),
    );
    if (!anyProcessing) {
      if (processingPollRef.current != null) {
        window.clearInterval(processingPollRef.current);
        processingPollRef.current = null;
      }
      return;
    }
    setNowMs(Date.now());
    processingPollRef.current = window.setInterval(() => {
      setNowMs(Date.now());
      void refresh({ silent: true });
      void refreshDiagnostics();
    }, 8000);
    return () => {
      if (processingPollRef.current != null) {
        window.clearInterval(processingPollRef.current);
        processingPollRef.current = null;
      }
    };
  }, [videos, refresh, refreshDiagnostics]);

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

  function openRename(v: VideoRow) {
    setRenamingVideo(v);
    setRenameTitle(v.title);
    setRenameDescription(v.description || "");
  }

  function closeRename() {
    setRenamingVideo(null);
    setRenameTitle("");
    setRenameDescription("");
  }

  async function saveRename(e: FormEvent) {
    e.preventDefault();
    if (!renamingVideo) return;
    setBusyId(renamingVideo.id);
    setError(null);
    setMessage(null);
    try {
      const callable = httpsCallable(functions, "updateVideoMetadata");
      await callable({
        videoId: renamingVideo.id,
        title: renameTitle.trim(),
        description: renameDescription.trim(),
      });
      setMessage("Video label updated.");
      closeRename();
      await refresh();
    } catch (err) {
      setError(mapUploadError(err));
    } finally {
      setBusyId(null);
    }
  }

  function openSlideEditor(v: VideoRow) {
    setEditingSlides(v);
    setSlideMarkers(v.slideMarkers ? [...v.slideMarkers] : []);
  }

  function closeSlideEditor() {
    setEditingSlides(null);
    setSlideMarkers([]);
  }

  function addSlideMarker() {
    const newMarker: SlideMarker = {
      id: `slide_${Date.now()}`,
      index: slideMarkers.length,
      timeSeconds: 0,
      title: null,
      source: "manual",
    };
    setSlideMarkers([...slideMarkers, newMarker]);
  }

  function removeSlideMarker(id: string) {
    setSlideMarkers(slideMarkers.filter((m) => m.id !== id));
  }

  function updateSlideMarker(id: string, updates: Partial<SlideMarker>) {
    setSlideMarkers(
      slideMarkers.map((m) => (m.id === id ? { ...m, ...updates } : m)),
    );
  }

  async function saveSlideMarkers(e: FormEvent) {
    e.preventDefault();
    if (!editingSlides) return;
    setSlidesSaving(true);
    setError(null);
    setMessage(null);
    try {
      const callable = httpsCallable(functions, "updateVideoSlideMarkers");
      await callable({
        videoId: editingSlides.id,
        markers: slideMarkers.sort((a, b) => a.timeSeconds - b.timeSeconds),
      });
      setMessage("Slide markers saved.");
      closeSlideEditor();
      await refresh();
    } catch (err) {
      setError(mapUploadError(err));
    } finally {
      setSlidesSaving(false);
    }
  }

  function hasSlideSupport(v: VideoRow): boolean {
    return Boolean(
      v.slideMarkers?.length ||
      v.processing?.status === VIDEO_PROCESSING_STATUS.READY ||
      v.processing?.status === VIDEO_PROCESSING_STATUS.SKIPPED_COMPATIBLE,
    );
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
            Company: {companyId || "—"} · Multiple videos may be Active at once
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

      {canManage && diagnostics.length > 0 ? (
        <section className="panel processing-diagnostics-panel">
          <h2>Admin Diagnostics — Video Processing</h2>
          <p className="muted small">
            Live processing state from backend workers. Progress survives refresh and other admin sessions.
          </p>
          <ul className="processing-diagnostics-list">
            {diagnostics.map((d) => {
              const inProgress = isVideoProcessingInProgress(d.status);
              const failed = d.status === VIDEO_PROCESSING_STATUS.FAILED || d.outcome === "failed";
              return (
                <li key={d.videoId} className="processing-diagnostics-item">
                  <strong>{d.title || d.videoId}</strong>
                  <div className="muted small">
                    Status:{" "}
                    {failed
                      ? "Processing Failed"
                      : inProgress
                        ? "Processing"
                        : videoProcessingStatusLabel(d.status)}
                  </div>
                  {d.stage ? <div className="muted small">Stage: {d.stage}</div> : null}
                  {typeof d.progressPercent === "number" ? (
                    <div className="muted small">
                      {failed ? "Last Progress" : "Progress"}: {d.progressPercent}%
                    </div>
                  ) : null}
                  {d.startedAt ? (
                    <div className="muted small">Started: {formatDateTime(d.startedAt)}</div>
                  ) : null}
                  {d.lastProgressAt ? (
                    <div className="muted small">
                      Last activity: {formatDateTime(d.lastProgressAt)}
                    </div>
                  ) : null}
                  {d.jobId ? <div className="muted small">Job: {d.jobId}</div> : null}
                  {failed && d.failureCategory ? (
                    <div className="muted small">
                      Reason: {String(d.failureCategory).replace(/_/g, " ")}
                    </div>
                  ) : null}
                  {failed && d.errorCode ? (
                    <div className="error small">Error ID: {d.errorCode}</div>
                  ) : null}
                  {failed && d.ffmpegErrorSummary ? (
                    <div className="muted small">{String(d.ffmpegErrorSummary).slice(0, 220)}</div>
                  ) : null}
                  {failed ? (
                    <button
                      type="button"
                      disabled={busyId === d.videoId}
                      onClick={() => void optimizeVideo(d.videoId, "optimize")}
                    >
                      {busyId === d.videoId ? "Queuing…" : "Retry Processing"}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="panel table-panel">
        <div className="video-library-header">
          <h2>Library</h2>
          <div className="video-library-actions">
            <button
              type="button"
              className="ghost"
              disabled={bulkOptimizing || currentView === "archived"}
              onClick={() => {
                if (!window.confirm("Queue all unoptimized videos for processing?")) return;
                void bulkOptimizeVideos();
              }}
            >
              {bulkOptimizing
                ? bulkProgress
                  ? `${bulkProgress.done} of ${bulkProgress.total} videos processed`
                  : "Queuing…"
                : "Optimize Existing Videos"}
            </button>
          </div>
        </div>

        <div className="video-tabs">
          <button
            type="button"
            className={currentView === "active" ? "tab-active" : ""}
            onClick={() => setCurrentView("active")}
          >
            Active Videos
          </button>
          <button
            type="button"
            className={currentView === "archived" ? "tab-active" : ""}
            onClick={() => setCurrentView("archived")}
          >
            Archived Videos
          </button>
        </div>

        {bulkProgress ? (
          <p className="muted small bulk-optimize-progress">
            Bulk optimization: {bulkProgress.done} of {bulkProgress.total} videos processed
          </p>
        ) : null}

        {loading ? <p className="muted">Loading…</p> : null}
        {!loading && filteredVideos.length === 0 ? (
          <p className="muted">
            {currentView === "archived"
              ? "No archived videos."
              : "No videos yet. Upload an MP4 to begin."}
          </p>
        ) : null}
        {filteredVideos.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Version</th>
                  <th>Duration</th>
                  <th>Processing</th>
                  <th>Status</th>
                  {currentView === "archived" ? <th>Deletion</th> : null}
                  <th>Upload date</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredVideos.map((v) => {
                  const stuck = needsFinalization(v);
                  const needsOpt = videoNeedsOptimization(v);
                  const processingStatus = v.processing?.status;
                  const isReady = processingStatus === VIDEO_PROCESSING_STATUS.READY ||
                                  processingStatus === VIDEO_PROCESSING_STATUS.SKIPPED_COMPATIBLE;
                  const isFailed = processingStatus === VIDEO_PROCESSING_STATUS.FAILED;
                  const isProcessing = isVideoProcessingInProgress(processingStatus);
                  const daysRemaining = daysUntilDeletion(v.scheduledPermanentDeletionAt);
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
                      <td>
                        {v.durationSeconds != null
                          ? `${Math.round(Number(v.durationSeconds))}s`
                          : "—"}
                      </td>
                      <td>
                        <span className={`processing-status processing-status-${processingStatus || "none"}`}>
                          {videoProcessingStatusLabel(processingStatus)}
                          {isProcessing ? "…" : ""}
                        </span>
                        <ProcessingProgressBlock v={v} nowMs={nowMs} />
                      </td>
                      <td>
                        <span className={`video-status video-status-${v.status}`}>
                          {statusLabel(String(v.status))}
                          {stuck ? " · pending finalize" : ""}
                        </span>
                      </td>
                      {currentView === "archived" ? (
                        <td>
                          {v.archivedAt ? (
                            <div className="muted small">
                              Archived: {formatDateTime(v.archivedAt)}
                            </div>
                          ) : null}
                          {daysRemaining !== null ? (
                            <div className={daysRemaining <= 7 ? "error small" : "muted small"}>
                              {daysRemaining === 0
                                ? "Scheduled for deletion"
                                : `${daysRemaining} day${daysRemaining !== 1 ? "s" : ""} until deletion`}
                            </div>
                          ) : null}
                          {v.deletionPostponedReason ? (
                            <div className="muted small">
                              Postponed: {v.deletionPostponedReason}
                            </div>
                          ) : null}
                        </td>
                      ) : null}
                      <td>{formatDateTime(v.uploadDate || v.createdAt)}</td>
                      <td>
                        <div className="video-actions">
                          {/* Active view actions */}
                          {currentView === "active" ? (
                            <>
                              {stuck ? (
                                <button
                                  type="button"
                                  disabled={busyId === v.id}
                                  onClick={() => void retryFinalization(v.id)}
                                >
                                  {busyId === v.id ? "Finalizing…" : "Retry Finalization"}
                                </button>
                              ) : null}
                              
                              {/* Optimize/Reprocess actions */}
                              {!stuck && isProcessing ? (
                                <button type="button" disabled>
                                  Processing…
                                </button>
                              ) : null}
                              {!stuck && needsOpt && !isFailed && !isProcessing ? (
                                <button
                                  type="button"
                                  disabled={busyId === v.id}
                                  onClick={() => void optimizeVideo(v.id, "optimize")}
                                >
                                  {busyId === v.id ? "Queuing…" : "Optimize for Portal"}
                                </button>
                              ) : null}
                              {!stuck && isFailed ? (
                                <button
                                  type="button"
                                  disabled={busyId === v.id}
                                  onClick={() => void optimizeVideo(v.id, "optimize")}
                                >
                                  {busyId === v.id ? "Queuing…" : "Retry Processing"}
                                </button>
                              ) : null}
                              {!stuck && isReady ? (
                                <button
                                  type="button"
                                  className="ghost"
                                  disabled={busyId === v.id}
                                  onClick={() => {
                                    if (!window.confirm("Re-run video processing? This will re-analyze and potentially re-transcode the video.")) return;
                                    void optimizeVideo(v.id, "reprocess");
                                  }}
                                >
                                  {busyId === v.id ? "Queuing…" : "Reprocess Video"}
                                </button>
                              ) : null}
                              
                              <button
                                type="button"
                                className="ghost"
                                disabled={busyId === v.id || stuck}
                                onClick={() => openRename(v)}
                              >
                                Rename
                              </button>
                              {hasSlideSupport(v) ? (
                                <button
                                  type="button"
                                  className="ghost"
                                  disabled={busyId === v.id}
                                  onClick={() => openSlideEditor(v)}
                                >
                                  Slides
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
                                  onClick={() => void runAction(v.id, "deactivateVideo")}
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
                                      if (!window.confirm("Permanently delete this video and its Storage file?")) return;
                                      void runAction(v.id, "deleteVideo", { permanent: true, confirm: true });
                                      return;
                                    }
                                    if (!window.confirm("Soft-delete this video?")) return;
                                    void runAction(v.id, "deleteVideo");
                                  }}
                                >
                                  Delete
                                </button>
                              ) : null}
                            </>
                          ) : null}
                          
                          {/* Archived view actions */}
                          {currentView === "archived" ? (
                            <>
                              <button
                                type="button"
                                disabled={busyId === v.id}
                                onClick={() => void restoreVideo(v.id)}
                              >
                                {busyId === v.id ? "Restoring…" : "Restore"}
                              </button>
                              {canPermanentDelete ? (
                                <button
                                  type="button"
                                  className="ghost danger"
                                  disabled={busyId === v.id}
                                  onClick={() => {
                                    const confirmText = `I understand this will permanently delete "${v.title}" and all associated storage files. This action cannot be undone.`;
                                    const userInput = window.prompt(
                                      `To permanently delete this video, type:\n\n${confirmText}\n\nNote: Deletion may be postponed if active sessions exist.`
                                    );
                                    if (userInput !== confirmText) {
                                      if (userInput !== null) {
                                        setError("Confirmation text did not match. Deletion cancelled.");
                                      }
                                      return;
                                    }
                                    void permanentDeleteVideo(v.id);
                                  }}
                                >
                                  {busyId === v.id ? "Deleting…" : "Delete Permanently Now"}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="ghost"
                                disabled={busyId === v.id}
                                onClick={() => void preview(v.id)}
                              >
                                Preview
                              </button>
                            </>
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

      {renamingVideo ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <section className="panel modal-panel presentation-access-modal">
            <h2>Rename video</h2>
            <p className="muted">
              Update the label shown in the Video Library and representative assignment
              dropdowns.
            </p>
            <form className="stack-form" onSubmit={(e) => void saveRename(e)}>
              <label>
                Title
                <input
                  value={renameTitle}
                  onChange={(e) => setRenameTitle(e.target.value)}
                  required
                  maxLength={200}
                />
              </label>
              <label>
                Description
                <textarea
                  rows={3}
                  value={renameDescription}
                  onChange={(e) => setRenameDescription(e.target.value)}
                  maxLength={2000}
                />
              </label>
              <div className="inline-actions">
                <button type="button" className="ghost" onClick={closeRename}>
                  Cancel
                </button>
                <button type="submit" disabled={busyId === renamingVideo.id}>
                  {busyId === renamingVideo.id ? "Saving…" : "Save label"}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {previewUrl ? (
        <section className="panel">
          <h2>Preview</h2>
          <video className="video-preview" src={previewUrl} controls playsInline />
          <button type="button" className="ghost" onClick={() => setPreviewUrl(null)}>
            Close preview
          </button>
        </section>
      ) : null}

      {editingSlides ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <section className="panel modal-panel presentation-access-modal">
            <h2>Slide Markers — {editingSlides.title}</h2>
            <p className="muted">
              Add timestamps for slide navigation. Viewers can skip between slides
              during playback.
            </p>
            <form className="stack-form" onSubmit={(e) => void saveSlideMarkers(e)}>
              <div className="slide-markers-list">
                {slideMarkers
                  .sort((a, b) => a.timeSeconds - b.timeSeconds)
                  .map((marker, idx) => (
                    <div key={marker.id} className="slide-marker-row">
                      <span className="slide-marker-index">{idx + 1}</span>
                      <label>
                        Time (seconds)
                        <input
                          type="number"
                          min={0}
                          max={editingSlides.durationSeconds || 9999}
                          step={0.1}
                          value={marker.timeSeconds}
                          onChange={(e) =>
                            updateSlideMarker(marker.id, {
                              timeSeconds: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Title (optional)
                        <input
                          type="text"
                          value={marker.title || ""}
                          placeholder="Slide title"
                          maxLength={100}
                          onChange={(e) =>
                            updateSlideMarker(marker.id, {
                              title: e.target.value || null,
                            })
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => removeSlideMarker(marker.id)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
              </div>
              <button type="button" className="ghost" onClick={addSlideMarker}>
                + Add Slide Marker
              </button>
              <div className="inline-actions">
                <button type="button" className="ghost" onClick={closeSlideEditor}>
                  Cancel
                </button>
                <button type="submit" disabled={slidesSaving}>
                  {slidesSaving ? "Saving…" : "Save Markers"}
                </button>
              </div>
            </form>
          </section>
        </div>
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
