import { useCallback, useEffect, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import {
  MEANINGFUL_PLAYBACK_SECONDS,
  PLAYBACK_SPEEDS,
  SIGNED_URL_REFRESH_BEFORE_MS,
  SLIDE_RESTART_THRESHOLD_SECONDS,
  type SlideMarker,
  type PlaybackSpeed,
} from "@spp/shared";
import { functions } from "@/lib/firebase";
import { getOrCreateDeviceId } from "@/lib/deviceId";
import {
  ACTIVITY_EVENT,
  ACTIVITY_SEVERITY,
  logClientActivity,
} from "@/lib/clientActivity";
import {
  shouldApplyLeaseVideoUrl,
  shouldStartLeaseAcquire,
} from "./presentationPlayer.pure";
import "./presentationPlayer.css";

interface Props {
  sessionId: string;
  src: string;
  title?: string;
  expiresAt?: string;
  slideMarkers?: SlideMarker[] | null;
  onUrlRefresh: (url: string) => void;
  onUrlExpired: () => void;
  onPlaybackFailed?: () => void;
  onComplete?: () => void;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function generateErrorId(): string {
  return `VID-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
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

export function PresentationPlayer({
  sessionId,
  src,
  title = "Presentation",
  expiresAt,
  slideMarkers,
  onUrlRefresh,
  onUrlExpired,
  onPlaybackFailed,
  onComplete,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [playbackRate, setPlaybackRate] = useState<PlaybackSpeed>(1);
  const [isBuffering, setIsBuffering] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<{ message: string; code: string } | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [currentSlideIndex, setCurrentSlideIndex] = useState(0);

  const leaseAcquiredRef = useRef(false);
  const leaseAcquireInFlightRef = useRef(false);
  const lastHeartbeatRef = useRef(0);
  const urlExpiresAtRef = useRef<number>(0);
  const refreshScheduledRef = useRef(false);
  const srcRef = useRef(src);
  const onUrlRefreshRef = useRef(onUrlRefresh);
  const onUrlExpiredRef = useRef(onUrlExpired);
  const onPlaybackFailedRef = useRef(onPlaybackFailed);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    srcRef.current = src;
  }, [src]);
  useEffect(() => {
    onUrlRefreshRef.current = onUrlRefresh;
  }, [onUrlRefresh]);
  useEffect(() => {
    onUrlExpiredRef.current = onUrlExpired;
  }, [onUrlExpired]);
  useEffect(() => {
    onPlaybackFailedRef.current = onPlaybackFailed;
  }, [onPlaybackFailed]);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  const sortedSlides = slideMarkers
    ? [...slideMarkers].sort((a, b) => a.timeSeconds - b.timeSeconds)
    : [];

  // Update URL expiration time
  useEffect(() => {
    if (expiresAt) {
      urlExpiresAtRef.current = new Date(expiresAt).getTime();
    }
  }, [expiresAt]);

  // Schedule URL refresh before expiration (stable callbacks — avoid reschedule churn).
  useEffect(() => {
    if (!expiresAt || refreshScheduledRef.current) return;

    const expiresAtMs = new Date(expiresAt).getTime();
    const refreshAtMs = expiresAtMs - SIGNED_URL_REFRESH_BEFORE_MS;
    const delay = refreshAtMs - Date.now();

    if (delay <= 0) return;

    refreshScheduledRef.current = true;
    const timer = window.setTimeout(async () => {
      try {
        const callable = httpsCallable(functions, "grantVideoAccess");
        const result = await callable({
          sessionId,
          deviceId: getOrCreateDeviceId(),
        });
        const data = result.data as { videoUrl: string; expiresAt: string };
        if (data.videoUrl) {
          // Proactive TTL refresh is the only intentional src replacement.
          onUrlRefreshRef.current(data.videoUrl);
          urlExpiresAtRef.current = new Date(data.expiresAt).getTime();
        }
      } catch {
        // Will retry on next heartbeat or trigger expiry
      }
      refreshScheduledRef.current = false;
    }, delay);

    return () => {
      window.clearTimeout(timer);
      refreshScheduledRef.current = false;
    };
  }, [expiresAt, sessionId]);

  // Disable context menu and setup video element (do not depend on src —
  // re-running on every URL change is unnecessary and risks listener thrash).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onContextMenu = (e: Event) => e.preventDefault();
    video.addEventListener("contextmenu", onContextMenu);
    video.setAttribute("controlsList", "nodownload noremoteplayback");
    video.setAttribute("playsinline", "true");
    video.setAttribute("webkit-playsinline", "true");
    video.disablePictureInPicture = true;

    return () => video.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Track current slide
  useEffect(() => {
    if (!sortedSlides.length) return;
    let idx = 0;
    for (let i = sortedSlides.length - 1; i >= 0; i--) {
      if (currentTime >= sortedSlides[i].timeSeconds) {
        idx = i;
        break;
      }
    }
    if (idx !== currentSlideIndex) {
      setCurrentSlideIndex(idx);
    }
  }, [currentTime, sortedSlides, currentSlideIndex]);

  // Acquire lease on meaningful playback — must NOT replace video src.
  const ensureLease = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    if (
      !shouldStartLeaseAcquire({
        alreadyAcquired: leaseAcquiredRef.current,
        inFlight: leaseAcquireInFlightRef.current,
        currentTimeSeconds: video.currentTime,
        meaningfulPlaybackSeconds: MEANINGFUL_PLAYBACK_SECONDS,
      })
    ) {
      return;
    }

    leaseAcquireInFlightRef.current = true;
    try {
      const acquire = httpsCallable(functions, "acquireViewingLease");
      const result = await acquire({
        sessionId,
        deviceId: getOrCreateDeviceId(),
        currentTime: video.currentTime,
      });
      const data = result.data as { videoUrl?: string };
      leaseAcquiredRef.current = true;
      // Critical: do not assign lease videoUrl to <video src> — that reloads media.
      if (
        shouldApplyLeaseVideoUrl({
          existingSrc: srcRef.current,
          leaseVideoUrl: data.videoUrl,
        })
      ) {
        onUrlRefreshRef.current(String(data.videoUrl));
      }
    } catch (err) {
      const message = mapPlayerError(err);
      if (message.toLowerCase().includes("already been viewed")) {
        setCompleted(true);
        video.pause();
      } else {
        video.pause();
        setError({ message, code: generateErrorId() });
        void logClientActivity({
          sessionId,
          type: ACTIVITY_EVENT.PLAYBACK_ERROR,
          severity: ACTIVITY_SEVERITY.ERROR,
          description: "Unable to acquire viewing lease for playback.",
          errorCode: "LEASE_ACQUIRE_FAILED",
        });
        onPlaybackFailedRef.current?.();
      }
    } finally {
      leaseAcquireInFlightRef.current = false;
    }
  }, [sessionId]);

  // Heartbeat (throttled to every 5 seconds) — renews lease only; never changes src.
  const sendHeartbeat = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.duration || Number.isNaN(video.duration)) return;
    if (video.currentTime < MEANINGFUL_PLAYBACK_SECONDS) return;

    const now = Date.now();
    if (now - lastHeartbeatRef.current < 5000) return;
    lastHeartbeatRef.current = now;

    if (!leaseAcquiredRef.current) {
      await ensureLease();
      return;
    }

    try {
      const heartbeat = httpsCallable(functions, "heartbeatPlayback");
      const result = await heartbeat({
        sessionId,
        deviceId: getOrCreateDeviceId(),
        currentTime: video.currentTime,
        duration: video.duration,
      });
      const data = result.data as { completed?: boolean };
      if (data.completed) {
        setCompleted(true);
        video.pause();
        onCompleteRef.current?.();
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
        onUrlExpiredRef.current();
      } else {
        video.pause();
        setError({ message, code: generateErrorId() });
      }
    }
  }, [sessionId, ensureLease]);

  // Video event handlers — stable deps so listeners are not torn down every parent render.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || completed) return;

    const onPlay = () => {
      setIsPlaying(true);
      setError(null);
      void ensureLease();
    };

    const onPause = () => setIsPlaying(false);

    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      if (
        !leaseAcquiredRef.current &&
        video.currentTime >= MEANINGFUL_PLAYBACK_SECONDS &&
        !video.paused
      ) {
        void ensureLease();
      }
      void sendHeartbeat();
    };

    const onDurationChange = () => setDuration(video.duration);

    const onProgress = () => {
      if (video.buffered.length > 0) {
        setBuffered(video.buffered.end(video.buffered.length - 1));
      }
    };

    const onWaiting = () => setIsBuffering(true);
    const onPlaying = () => setIsBuffering(false);
    const onCanPlay = () => setIsBuffering(false);

    const onVolumeChange = () => {
      setVolume(video.volume);
      setIsMuted(video.muted);
    };

    const onRateChange = () => {
      setPlaybackRate(video.playbackRate as PlaybackSpeed);
    };

    const onEnded = async () => {
      try {
        const complete = httpsCallable(functions, "completeVideo");
        await complete({ sessionId, deviceId: getOrCreateDeviceId() });
        setCompleted(true);
        onCompleteRef.current?.();
      } catch {
        setError({
          message: "We were unable to finalize completion. Please contact your representative.",
          code: generateErrorId(),
        });
      }
    };

    const onError = () => {
      setIsBuffering(false);
      setError({
        message: "We're sorry, but there was a problem loading your presentation. Please contact your representative for assistance.",
        code: generateErrorId(),
      });
      void logClientActivity({
        sessionId,
        type: ACTIVITY_EVENT.MEDIA_ERROR,
        severity: ACTIVITY_SEVERITY.ERROR,
        description: "Media element reported a playback error.",
        errorCode: "MEDIA_ELEMENT_ERROR",
      });
      onPlaybackFailedRef.current?.();
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("durationchange", onDurationChange);
    video.addEventListener("progress", onProgress);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("volumechange", onVolumeChange);
    video.addEventListener("ratechange", onRateChange);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("durationchange", onDurationChange);
      video.removeEventListener("progress", onProgress);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("volumechange", onVolumeChange);
      video.removeEventListener("ratechange", onRateChange);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onError);
    };
  }, [sessionId, completed, ensureLease, sendHeartbeat]);

  // Control handlers
  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  }

  function seek(time: number) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(time, duration));
  }

  function handleProgressClick(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    seek(percent * duration);
  }

  function handleVolumeChange(newVolume: number) {
    const video = videoRef.current;
    if (!video) return;
    video.volume = newVolume;
    video.muted = newVolume === 0;
  }

  function toggleMute() {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
  }

  function handleRateChange(rate: PlaybackSpeed) {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = rate;
    void logClientActivity({
      sessionId,
      type: ACTIVITY_EVENT.PLAYBACK_RATE_CHANGED,
      severity: ACTIVITY_SEVERITY.INFO,
      description: `Playback rate changed to ${rate}x`,
    });
  }

  function toggleFullscreen() {
    const container = containerRef.current;
    if (!container) return;
    if (!document.fullscreenElement) {
      void container.requestFullscreen();
      setIsFullscreen(true);
    } else {
      void document.exitFullscreen();
      setIsFullscreen(false);
    }
  }

  function goToPrevSlide() {
    if (!sortedSlides.length) return;
    const current = sortedSlides[currentSlideIndex];
    const timeIntoSlide = currentTime - current.timeSeconds;

    if (timeIntoSlide > SLIDE_RESTART_THRESHOLD_SECONDS) {
      seek(current.timeSeconds);
    } else if (currentSlideIndex > 0) {
      seek(sortedSlides[currentSlideIndex - 1].timeSeconds);
    } else {
      seek(0);
    }
  }

  function goToNextSlide() {
    if (!sortedSlides.length || currentSlideIndex >= sortedSlides.length - 1) return;
    seek(sortedSlides[currentSlideIndex + 1].timeSeconds);
  }

  function retry() {
    setError(null);
    setIsBuffering(true);
    const video = videoRef.current;
    if (video) {
      video.load();
    }
  }

  // Hide controls after 3s of inactivity
  useEffect(() => {
    if (!isPlaying) {
      setControlsVisible(true);
      return;
    }
    const timer = window.setTimeout(() => setControlsVisible(false), 3000);
    return () => window.clearTimeout(timer);
  }, [isPlaying, currentTime]);

  function showControls() {
    setControlsVisible(true);
  }

  if (completed) {
    return (
      <div className="presentation-player">
        <div className="player-completed">
          <h2>Presentation Complete</h2>
          <p>
            Thank you for watching. This presentation has been completed and
            cannot be viewed again.
          </p>
          <p style={{ fontSize: "0.875rem", marginTop: "0.5rem", opacity: 0.8 }}>
            Please contact your representative if you need assistance.
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="presentation-player">
        <div className="player-error">
          <h3>We're sorry</h3>
          <p>{error.message}</p>
          <p className="player-error-code">Error ID: {error.code}</p>
          <button type="button" className="player-error-btn" onClick={retry}>
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`presentation-player ${controlsVisible ? "controls-visible" : ""}`}
      onMouseMove={showControls}
      onTouchStart={showControls}
    >
      <h1 className="player-title">{title}</h1>
      <video
        ref={videoRef}
        src={src}
        preload="metadata"
        playsInline
        onClick={togglePlay}
      />

      {isBuffering && (
        <div className="player-buffering">
          <div className="player-buffering-spinner" />
          <span>Buffering...</span>
        </div>
      )}

      <div className="player-controls">
        <div className="player-progress" onClick={handleProgressClick}>
          <div
            className="player-progress-buffered"
            style={{ width: `${(buffered / duration) * 100}%` }}
          />
          <div
            className="player-progress-filled"
            style={{ width: `${(currentTime / duration) * 100}%` }}
          />
        </div>

        <div className="player-buttons">
          <button
            type="button"
            className="player-btn"
            onClick={togglePlay}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
            ) : (
              <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
            )}
          </button>

          {sortedSlides.length > 0 && (
            <div className="player-slide-nav">
              <button
                type="button"
                className="player-btn"
                onClick={goToPrevSlide}
                aria-label="Previous slide"
              >
                <svg viewBox="0 0 24 24"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" /></svg>
              </button>
              <span className="player-slide-indicator">
                {currentSlideIndex + 1}/{sortedSlides.length}
              </span>
              <button
                type="button"
                className="player-btn"
                onClick={goToNextSlide}
                disabled={currentSlideIndex >= sortedSlides.length - 1}
                aria-label="Next slide"
              >
                <svg viewBox="0 0 24 24"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" /></svg>
              </button>
            </div>
          )}

          <span className="player-time">
            {formatTime(currentTime)} / {formatTime(duration || 0)}
          </span>

          <div className="player-spacer" />

          <div className="player-volume-group">
            <button
              type="button"
              className="player-btn"
              onClick={toggleMute}
              aria-label={isMuted ? "Unmute" : "Mute"}
            >
              {isMuted || volume === 0 ? (
                <svg viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" /></svg>
              ) : (
                <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" /></svg>
              )}
            </button>
            <input
              type="range"
              className="player-volume-slider"
              min={0}
              max={1}
              step={0.1}
              value={isMuted ? 0 : volume}
              onChange={(e) => handleVolumeChange(Number(e.target.value))}
              aria-label="Volume"
            />
          </div>

          <select
            className="player-speed-select"
            value={playbackRate}
            onChange={(e) => handleRateChange(Number(e.target.value) as PlaybackSpeed)}
            aria-label="Playback speed"
          >
            {PLAYBACK_SPEEDS.map((speed) => (
              <option key={speed} value={speed}>
                {speed}x
              </option>
            ))}
          </select>

          <button
            type="button"
            className="player-btn"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          >
            {isFullscreen ? (
              <svg viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" /></svg>
            ) : (
              <svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" /></svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
