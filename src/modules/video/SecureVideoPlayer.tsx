import { useEffect, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { MEANINGFUL_PLAYBACK_SECONDS } from "@spp/shared";
import { functions } from "@/lib/firebase";
import { getOrCreateDeviceId } from "@/lib/deviceId";
import {
  ACTIVITY_EVENT,
  ACTIVITY_SEVERITY,
  logClientActivity,
} from "@/lib/clientActivity";

interface Props {
  sessionId: string;
  src: string;
  title?: string;
  onUrlRefresh: (url: string) => void;
  onUrlExpired: () => void;
  onPlaybackFailed?: () => void;
}

function mapPlayerError(err: unknown): string {
  const raw =
    err && typeof err === "object" && "message" in err
      ? String((err as { message: string }).message)
      : "";
  const lower = raw.toLowerCase();
  if (lower.includes("already been viewed")) {
    return "This presentation has already been viewed.";
  }
  if (lower.includes("another device")) {
    return "This presentation is already being viewed on another device.";
  }
  return "We're sorry, but there was a problem loading your presentation. Please contact your representative for assistance.";
}

/**
 * Native HTML5 video player for cross-device client presentations.
 * Viewing lease is acquired only after meaningful playback begins.
 */
export function SecureVideoPlayer({
  sessionId,
  src,
  title = "Presentation",
  onUrlRefresh,
  onUrlExpired,
  onPlaybackFailed,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(false);
  const [loadingMedia, setLoadingMedia] = useState(true);
  const leaseAcquiredRef = useRef(false);
  const lastBufferLogRef = useRef(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onContextMenu = (e: Event) => e.preventDefault();
    video.addEventListener("contextmenu", onContextMenu);
    // Prefer native controls; nodownload is best-effort only.
    video.setAttribute("controlsList", "nodownload");
    video.setAttribute("playsinline", "true");
    video.setAttribute("webkit-playsinline", "true");

    return () => video.removeEventListener("contextmenu", onContextMenu);
  }, [src]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || completed) return;

    const acquire = httpsCallable(functions, "acquireViewingLease");
    const heartbeat = httpsCallable(functions, "heartbeatPlayback");
    const complete = httpsCallable(functions, "completeVideo");
    const deviceId = getOrCreateDeviceId();

    const ensureLease = async () => {
      if (video.currentTime < MEANINGFUL_PLAYBACK_SECONDS) return;
      try {
        const result = await acquire({
          sessionId,
          deviceId,
          currentTime: video.currentTime,
        });
        const data = result.data as { videoUrl?: string };
        leaseAcquiredRef.current = true;
        if (data.videoUrl) onUrlRefresh(data.videoUrl);
      } catch (err) {
        const message = mapPlayerError(err);
        if (message.toLowerCase().includes("already been viewed")) {
          setCompleted(true);
          video.pause();
        } else {
          video.pause();
          setError(message);
          void logClientActivity({
            sessionId,
            type: ACTIVITY_EVENT.PLAYBACK_ERROR,
            severity: ACTIVITY_SEVERITY.ERROR,
            description: "Unable to acquire viewing lease for playback.",
            errorCode: "LEASE_ACQUIRE_FAILED",
          });
          onPlaybackFailed?.();
        }
      }
    };

    const sendHeartbeat = async () => {
      if (!video.duration || Number.isNaN(video.duration)) return;
      if (video.currentTime < MEANINGFUL_PLAYBACK_SECONDS) return;
      if (!leaseAcquiredRef.current) {
        await ensureLease();
        return;
      }
      try {
        const result = await heartbeat({
          sessionId,
          deviceId,
          currentTime: video.currentTime,
          duration: video.duration,
        });
        const data = result.data as { completed?: boolean };
        if (data.completed) {
          setCompleted(true);
          video.pause();
        }
      } catch (err) {
        const message = mapPlayerError(err);
        const raw =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: string }).message).toLowerCase()
            : "";
        if (message.toLowerCase().includes("already been viewed")) {
          setCompleted(true);
          video.pause();
        } else if (
          raw.includes("lease expired") ||
          raw.includes("signed") ||
          raw.includes("403")
        ) {
          onUrlExpired();
        } else {
          video.pause();
          setError(message);
        }
      }
    };

    const onPlay = () => {
      setError(null);
      void ensureLease();
    };

    const onTimeUpdate = () => {
      if (
        !leaseAcquiredRef.current &&
        video.currentTime >= MEANINGFUL_PLAYBACK_SECONDS &&
        !video.paused
      ) {
        void ensureLease();
      }
    };

    const onWaiting = () => {
      setBuffering(true);
      const now = Date.now();
      // Throttle buffering logs (once per 30s while buffering).
      if (now - lastBufferLogRef.current > 30_000) {
        lastBufferLogRef.current = now;
        void logClientActivity({
          sessionId,
          type: ACTIVITY_EVENT.VIDEO_BUFFERING,
          severity: ACTIVITY_SEVERITY.WARNING,
          description: "Video buffering while loading media.",
        });
      }
    };
    const onPlaying = () => {
      setBuffering(false);
      setLoadingMedia(false);
    };
    const onCanPlay = () => {
      setLoadingMedia(false);
      setBuffering(false);
    };
    const onLoadStart = () => setLoadingMedia(true);
    const onMediaError = () => {
      setLoadingMedia(false);
      setBuffering(false);
      setError(
        "We're sorry, but there was a problem loading your presentation. Please contact your representative for assistance.",
      );
      void logClientActivity({
        sessionId,
        type: ACTIVITY_EVENT.PLAYBACK_ERROR,
        severity: ACTIVITY_SEVERITY.ERROR,
        description: "Media element reported a playback error.",
        errorCode: "MEDIA_ELEMENT_ERROR",
      });
      onPlaybackFailed?.();
    };

    const interval = window.setInterval(() => {
      if (!video.paused && !video.ended) void sendHeartbeat();
    }, 5000);

    const onEnded = async () => {
      try {
        await complete({ sessionId, deviceId });
        setCompleted(true);
      } catch {
        setError(
          "We were unable to finalize completion. Please contact your representative.",
        );
      }
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("ended", onEnded);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("loadstart", onLoadStart);
    video.addEventListener("error", onMediaError);

    return () => {
      window.clearInterval(interval);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("loadstart", onLoadStart);
      video.removeEventListener("error", onMediaError);
    };
  }, [
    sessionId,
    src,
    completed,
    onUrlExpired,
    onUrlRefresh,
    onPlaybackFailed,
  ]);

  function tryAgain() {
    setError(null);
    setLoadingMedia(true);
    const video = videoRef.current;
    if (!video) {
      onPlaybackFailed?.();
      return;
    }
    video.load();
  }

  if (completed) {
    return (
      <div className="video-complete client-state-panel">
        <p className="eyebrow">Secure presentation</p>
        <h2>Presentation complete</h2>
        <p>
          Thank you for watching. This presentation has been completed and
          cannot be viewed again.
        </p>
        <p className="muted">Please contact your representative if you need assistance.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="client-state-panel">
        <p className="eyebrow">Secure presentation</p>
        <h2>We're sorry</h2>
        <p style={{ whiteSpace: "pre-line" }}>
          We're sorry, but there was a problem loading your presentation.
          {"\n\n"}
          Please contact your representative for assistance.
        </p>
        <button type="button" className="invite-continue-btn" onClick={tryAgain}>
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div className="video-frame" onContextMenu={(e) => e.preventDefault()}>
      <h1 className="video-title">{title}</h1>
      <p className="muted small">
        This viewing is one-time. When the presentation finishes, access closes
        permanently.
      </p>

      {loadingMedia ? (
        <div className="video-status-banner" role="status">
          <div className="invite-spinner" aria-hidden />
          <span>Loading Video...</span>
        </div>
      ) : null}
      {buffering && !loadingMedia ? (
        <div className="video-status-banner" role="status">
          <div className="invite-spinner" aria-hidden />
          <span>Buffering...</span>
        </div>
      ) : null}

      <video
        ref={videoRef}
        src={src}
        controls
        playsInline
        preload="metadata"
        controlsList="nodownload"
      />
    </div>
  );
}
