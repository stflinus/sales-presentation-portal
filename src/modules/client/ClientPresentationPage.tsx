import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { doc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { SESSION_STATUS, ACCESS_POLICY, type PresentationSession } from "@spp/shared";
import { db, functions } from "@/lib/firebase";
import { getOrCreateDeviceId } from "@/lib/deviceId";
import {
  ACTIVITY_EVENT,
  ACTIVITY_SEVERITY,
  logClientActivity,
} from "@/lib/clientActivity";
import { useAuth } from "@/modules/auth/AuthProvider";
import { SecureVideoPlayer } from "@/modules/video/SecureVideoPlayer";
import { LegalAcceptanceScreen } from "./LegalAcceptanceScreen";
import { mapClientSessionError, type ClientInviteError } from "./inviteErrors";

type Step =
  | "loading"
  | "legal"
  | "ready"
  | "preparing"
  | "video"
  | "done"
  | "blocked"
  | "error";

export function ClientPresentationPage() {
  const { sessionId = "" } = useParams();
  const {
    user,
    sessionId: claimSessionId,
    loading: authLoading,
    rehydrateFromToken,
  } = useAuth();
  const [session, setSession] = useState<PresentationSession | null>(null);
  const [error, setError] = useState<ClientInviteError | null>(null);
  const [claimsReady, setClaimsReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoTitle, setVideoTitle] = useState("Presentation");
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const readyLoggedRef = useRef(false);

  useEffect(() => {
    if (!sessionId || authLoading) return;
    let cancelled = false;

    async function ensureClaims() {
      if (!user) {
        if (!cancelled) {
          setError({
            kind: "unavailable",
            title: "Access unavailable",
            message:
              "This presentation is not authorized on this device. Please reopen the secure invitation link provided by your representative.",
          });
          setClaimsReady(false);
        }
        return;
      }

      if (claimSessionId === sessionId) {
        if (!cancelled) {
          setClaimsReady(true);
          setError(null);
        }
        return;
      }

      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await rehydrateFromToken();
          const result = await user.getIdTokenResult();
          if (result.claims.sessionId === sessionId) {
            if (!cancelled) {
              setClaimsReady(true);
              setError(null);
            }
            return;
          }
        } catch {
          // retry
        }
        await new Promise((r) => setTimeout(r, 250));
        if (cancelled) return;
      }

      if (!cancelled) {
        setClaimsReady(false);
        setError({
          kind: "unavailable",
          title: "Access unavailable",
          message:
            "This presentation is not authorized on this device. Please reopen the secure invitation link provided by your representative.",
        });
      }
    }

    void ensureClaims();
    return () => {
      cancelled = true;
    };
  }, [sessionId, user, claimSessionId, authLoading, rehydrateFromToken]);

  const step: Step = useMemo(() => {
    if (error && !session) return "error";
    if (!session) return "loading";

    const timeLimited = session.accessPolicy === ACCESS_POLICY.TIME_LIMITED;
    const expired =
      session.status === SESSION_STATUS.EXPIRED ||
      session.status === SESSION_STATUS.REVOKED ||
      (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now());

    if (expired) return "blocked";

    if (
      !timeLimited &&
      (session.status === SESSION_STATUS.COMPLETED ||
        session.status === SESSION_STATUS.CLOSED)
    ) {
      return "done";
    }

    if (
      session.status === SESSION_STATUS.REVOKED ||
      session.status === SESSION_STATUS.EXPIRED
    ) {
      return "blocked";
    }

    if (timeLimited && session.legalAcceptanceId) {
      if (started && videoUrl) return "video";
      if (started || preparing) return "preparing";
      return "ready";
    }

    if (session.status === SESSION_STATUS.IN_PROGRESS) {
      if (started && videoUrl) return "video";
      if (started || preparing) return "preparing";
      return started ? "preparing" : "ready";
    }
    if (session.status === SESSION_STATUS.LEGAL_ACCEPTED) {
      if (started && videoUrl) return "video";
      if (started || preparing) return "preparing";
      return "ready";
    }
    return "legal";
  }, [session, error, started, preparing, videoUrl]);

  useEffect(() => {
    if (!sessionId || authLoading || !claimsReady || !user) return;
    if (claimSessionId && claimSessionId !== sessionId) return;

    return onSnapshot(
      doc(db, "presentationSessions", sessionId),
      (snap) => {
        if (!snap.exists()) {
          setError({
            kind: "invalid",
            title: "Presentation not found",
            message:
              "This presentation could not be found. Please contact your representative.",
          });
          return;
        }
        const next = { ...(snap.data() as PresentationSession), id: snap.id };
        setSession(next);
        setError(null);
        // Resume: if already in progress, treat as ready to start (no autoplay).
        if (next.status === SESSION_STATUS.IN_PROGRESS) {
          // Keep explicit Start Presentation — do not autoplay.
        }
      },
      () => {
        setError({
          kind: "unavailable",
          title: "Unable to load presentation",
          message:
            "We could not load this presentation right now. Please try again shortly or contact your representative.",
        });
      },
    );
  }, [sessionId, user, claimSessionId, authLoading, claimsReady]);

  // Log Presentation Ready once when the ready screen becomes available.
  useEffect(() => {
    if (!sessionId || step !== "ready" || readyLoggedRef.current) return;
    readyLoggedRef.current = true;
    void logClientActivity({
      sessionId,
      type: ACTIVITY_EVENT.PRESENTATION_READY,
      severity: ACTIVITY_SEVERITY.SUCCESS,
      description: "Presentation ready screen displayed.",
    });
  }, [sessionId, step]);

  // Browser closed / tab hide — best-effort beacon via callable.
  useEffect(() => {
    if (!sessionId || !claimsReady) return;
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        void logClientActivity({
          sessionId,
          type: ACTIVITY_EVENT.BROWSER_CLOSED,
          severity: ACTIVITY_SEVERITY.WARNING,
          description: "Browser tab hidden or closed during presentation.",
        });
      }
    };
    const onOffline = () => {
      void logClientActivity({
        sessionId,
        type: ACTIVITY_EVENT.NETWORK_FAILURE,
        severity: ACTIVITY_SEVERITY.ERROR,
        description: "Network connection lost during presentation.",
        errorCode: "NETWORK_OFFLINE",
      });
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("offline", onOffline);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("offline", onOffline);
    };
  }, [sessionId, claimsReady]);

  async function loadVideoAccess(): Promise<boolean> {
    if (!sessionId) return false;
    setPreparing(true);
    setStartError(null);
    setInlineError(null);
    try {
      const callable = httpsCallable(functions, "grantVideoAccess");
      const result = await callable({
        sessionId,
        deviceId: getOrCreateDeviceId(),
      });
      const data = result.data as { videoUrl: string; title: string };
      setVideoUrl(data.videoUrl);
      setVideoTitle(data.title || "Presentation");
      setPreparing(false);
      return true;
    } catch (err) {
      const mapped = mapClientSessionError(err);
      setStartError(mapped.message);
      setPreparing(false);
      setStarted(false);
      void logClientActivity({
        sessionId,
        type: ACTIVITY_EVENT.PLAYBACK_ERROR,
        severity: ACTIVITY_SEVERITY.ERROR,
        description: "Unable to prepare video for playback.",
        errorCode: "GRANT_VIDEO_ACCESS_FAILED",
      });
      return false;
    }
  }

  async function startPresentation() {
    if (sessionId) {
      void logClientActivity({
        sessionId,
        type: ACTIVITY_EVENT.START_PRESENTATION_CLICKED,
        severity: ACTIVITY_SEVERITY.SUCCESS,
        description: "Client clicked Start Presentation.",
      });
    }
    setStarted(true);
    setStartError(null);
    const ok = await loadVideoAccess();
    if (!ok) {
      setStarted(false);
    }
  }

  async function acceptLegal(payload: {
    ndaChecked: boolean;
    termsPrivacyChecked: boolean;
    screenResolution: string;
  }) {
    if (!sessionId) return;
    setBusy(true);
    setInlineError(null);
    try {
      const callable = httpsCallable(functions, "acceptLegal");
      await callable({
        sessionId,
        ndaChecked: payload.ndaChecked,
        termsPrivacyChecked: payload.termsPrivacyChecked,
        screenResolution: payload.screenResolution,
      });
      // Session snapshot moves to LEGAL_ACCEPTED → ready screen.
      setStarted(false);
      setVideoUrl(null);
    } catch (err) {
      const mapped = mapClientSessionError(err);
      setInlineError(mapped.message);
    } finally {
      setBusy(false);
    }
  }

  if (authLoading || step === "loading" || (!claimsReady && !error)) {
    return (
      <div className="client-shell client-shell-safe">
        <div className="panel client-panel invite-loading-panel">
          <p className="eyebrow">Secure Invitation</p>
          <h1>Preparing Presentation...</h1>
          <div className="invite-spinner" role="status" aria-label="Loading" />
        </div>
      </div>
    );
  }

  if (step === "error" && error) {
    return (
      <div className="client-shell client-shell-safe">
        <div className="panel client-panel">
          <p className="eyebrow">Secure Invitation</p>
          <h1>{error.title}</h1>
          <p style={{ whiteSpace: "pre-line" }}>{error.message}</p>
        </div>
      </div>
    );
  }

  if (step === "done") {
    return (
      <div className="client-shell client-shell-safe">
        <div className="panel client-panel">
          <p className="eyebrow">Secure Invitation</p>
          <h1>Presentation already completed</h1>
          <p>
            This presentation has already been viewed and cannot be opened again.
            Please contact your representative if you need assistance.
          </p>
        </div>
      </div>
    );
  }

  if (step === "blocked") {
    const expired = session?.status === SESSION_STATUS.EXPIRED;
    return (
      <div className="client-shell client-shell-safe">
        <div className="panel client-panel">
          <p className="eyebrow">Secure Invitation</p>
          <h1>{expired ? "Invitation expired" : "Invitation unavailable"}</h1>
          <p>
            {expired
              ? "This invitation has expired. Please contact your representative to request a new secure invitation."
              : "This invitation is no longer active. Please contact your representative for a new link."}
          </p>
        </div>
      </div>
    );
  }

  if (step === "legal" && session) {
    return (
      <LegalAcceptanceScreen
        sessionId={sessionId}
        busy={busy}
        error={inlineError}
        onAccept={acceptLegal}
      />
    );
  }

  if (step === "ready" || (startError && !videoUrl)) {
    return (
      <div className="client-shell client-shell-safe">
        <div className="panel client-panel client-state-panel">
          <p className="eyebrow">Secure presentation</p>
          <h1>Your Presentation Is Ready</h1>
          <p>
            When you are ready, click the button below to begin.
          </p>
          <p className="muted small">
            This is a one-time viewing. Playback does not begin until you start
            the presentation.
          </p>
          {startError ? (
            <>
              <p className="error" style={{ whiteSpace: "pre-line" }}>
                We're sorry, but there was a problem loading your presentation.
                {"\n\n"}
                Please contact your representative for assistance.
              </p>
            </>
          ) : null}
          <button
            type="button"
            className="invite-continue-btn"
            disabled={preparing}
            onClick={() => void startPresentation()}
          >
            {preparing
              ? "Preparing…"
              : startError
                ? "Try Again"
                : "Start Presentation"}
          </button>
          {startError ? (
            <p className="muted small">
              If the issue continues, please contact your representative.
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  if (step === "preparing" || (started && !videoUrl && !startError)) {
    return (
      <div className="client-shell client-shell-safe">
        <div className="panel client-panel invite-loading-panel">
          <p className="eyebrow">Secure presentation</p>
          <h1>Loading Video...</h1>
          <div className="invite-spinner" role="status" aria-label="Loading" />
          <p className="muted small">Preparing your secure presentation.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="client-shell client-shell-safe">
      <div className="panel client-panel wide video-panel">
        {inlineError ? <p className="error">{inlineError}</p> : null}
        {videoUrl ? (
          <SecureVideoPlayer
            sessionId={sessionId}
            src={videoUrl}
            title={videoTitle}
            onUrlRefresh={(url) => setVideoUrl(url)}
            onUrlExpired={async () => {
              setVideoUrl(null);
              setStarted(true);
              await loadVideoAccess();
            }}
            onPlaybackFailed={() => {
              // Failed before meaningful playback — do not burn viewing.
              // Keep ready/retry path available by clearing URL and started if no lease.
            }}
          />
        ) : (
          <div className="invite-loading-panel compact">
            <div className="invite-spinner" role="status" aria-label="Loading" />
            <p className="muted">Loading Video...</p>
          </div>
        )}
      </div>
    </div>
  );
}
