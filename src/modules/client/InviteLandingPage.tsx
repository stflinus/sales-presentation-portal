import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { signInWithCustomToken } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useAuth } from "@/modules/auth/AuthProvider";
import {
  mapInviteError,
  type ClientInviteError,
} from "./inviteErrors";
import "./inviteLanding.css";

interface SessionInfo {
  sessionId: string;
  clientName: string;
  companyName: string;
}

type Phase = "loading" | "welcome" | "device-blocked" | "error";

async function apiCall(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`/api/viewer/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

export function InviteLandingPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { rehydrateFromToken } = useAuth();
  const [phase, setPhase] = useState<Phase>("loading");
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<ClientInviteError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!token) {
        if (!cancelled) {
          setError({
            kind: "invalid",
            title: "Invitation not found",
            message:
              "This invitation link is invalid or incomplete. Please use the secure link provided by your representative.",
          });
          setPhase("error");
        }
        return;
      }
      try {
        const resumeResult = (await apiCall("resume", { token })) as {
          ok: boolean;
          needsClaim?: boolean;
          deviceBlocked?: boolean;
          error?: string;
          customToken?: string;
          sessionId?: string;
          clientName?: string;
          companyName?: string;
        };

        if (cancelled) return;

        if (resumeResult.deviceBlocked) {
          setPhase("device-blocked");
          return;
        }

        if (resumeResult.ok && resumeResult.customToken) {
          await signInWithCustomToken(auth, resumeResult.customToken);
          await rehydrateFromToken();
          setSessionInfo({
            sessionId: resumeResult.sessionId || "",
            clientName: resumeResult.clientName || "Guest",
            companyName: resumeResult.companyName || "Presentation Hub",
          });
          setPhase("welcome");
          return;
        }

        // First open (or after device reset): claim this browser atomically.
        const claimResult = (await apiCall("claim", { token })) as {
          ok: boolean;
          deviceBlocked?: boolean;
          error?: string;
          customToken?: string;
          sessionId?: string;
          clientName?: string;
          companyName?: string;
        };

        if (cancelled) return;

        if (claimResult.deviceBlocked) {
          setPhase("device-blocked");
          return;
        }

        if (!claimResult.ok || !claimResult.customToken) {
          throw new Error(claimResult.error || "Unable to open this invitation.");
        }

        await signInWithCustomToken(auth, claimResult.customToken);
        await rehydrateFromToken();
        setSessionInfo({
          sessionId: claimResult.sessionId || "",
          clientName: claimResult.clientName || "Guest",
          companyName: claimResult.companyName || "Presentation Hub",
        });
        setPhase("welcome");
      } catch (err) {
        if (!cancelled) {
          setError(mapInviteError(err));
          setPhase("error");
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [token, rehydrateFromToken]);

  function onContinue() {
    if (!sessionInfo || busy) return;
    setBusy(true);
    navigate(`/p/${sessionInfo.sessionId}`, { replace: true });
  }

  if (phase === "loading") {
    return (
      <div className="client-shell">
        <div className="panel client-panel invite-loading-panel">
          <p className="eyebrow">Secure Invitation</p>
          <h1>Opening your presentation…</h1>
          <div className="invite-spinner" role="status" aria-label="Loading" />
          <p className="muted small">Please wait a moment.</p>
        </div>
      </div>
    );
  }

  if (phase === "error" && error) {
    return (
      <div className="client-shell">
        <div className="panel client-panel">
          <p className="eyebrow">Secure Invitation</p>
          <h1>{error.title}</h1>
          <p style={{ whiteSpace: "pre-line" }}>{error.message}</p>
        </div>
      </div>
    );
  }

  if (phase === "device-blocked") {
    return (
      <div className="client-shell">
        <div className="panel client-panel">
          <p className="eyebrow">Secure Invitation</p>
          <h1>Already opened on another device</h1>
          <div className="invite-device-blocked">
            <p>This presentation has already been opened on another device.</p>
            <p>Please use the original device, or contact your representative for assistance.</p>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "welcome" && sessionInfo) {
    return (
      <div className="client-shell">
        <div className="panel client-panel">
          <p className="eyebrow">Secure Invitation</p>
          <h1>Welcome, {sessionInfo.clientName}</h1>
          <p className="invite-company">{sessionInfo.companyName}</p>
          <p>
            You are ready to view your secure presentation. Next you will review
            the required legal documents, then watch the video.
          </p>
          <button
            type="button"
            className="invite-btn invite-btn-primary"
            disabled={busy}
            onClick={onContinue}
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="client-shell">
      <div className="panel client-panel">
        <p className="eyebrow">Secure Invitation</p>
        <h1>Unable to open invitation</h1>
        <p>
          We could not open this presentation right now. Please contact your
          representative.
        </p>
      </div>
    </div>
  );
}
