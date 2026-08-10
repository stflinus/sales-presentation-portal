import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { httpsCallable } from "firebase/functions";
import { signInWithCustomToken } from "firebase/auth";
import { auth, functions } from "@/lib/firebase";
import { getOrCreateDeviceId } from "@/lib/deviceId";
import { useAuth } from "@/modules/auth/AuthProvider";
import {
  mapInviteError,
  type ClientInviteError,
} from "./inviteErrors";

interface InviteWelcomePayload {
  customToken: string;
  sessionId: string;
  clientName: string;
  companyName: string;
  representativeName: string;
  videoTitle: string;
  estimatedDurationLabel: string;
  legalDocuments: Array<{
    type: string;
    title: string;
    versionLabel: string;
  }>;
}

type Phase = "loading" | "welcome" | "error";

export function InviteLandingPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { rehydrateFromToken } = useAuth();
  const [phase, setPhase] = useState<Phase>("loading");
  const [welcome, setWelcome] = useState<InviteWelcomePayload | null>(null);
  const [error, setError] = useState<ClientInviteError | null>(null);
  const [continuing, setContinuing] = useState(false);

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
        const deviceId = getOrCreateDeviceId();
        const exchange = httpsCallable(functions, "exchangeInviteToken");
        const result = await exchange({ token, deviceId });
        const data = result.data as InviteWelcomePayload;

        if (!data.customToken || !data.sessionId) {
          throw new Error("incomplete");
        }

        await signInWithCustomToken(auth, data.customToken);
        await rehydrateFromToken();

        if (cancelled) return;
        setWelcome({
          customToken: data.customToken,
          sessionId: data.sessionId,
          clientName: data.clientName || "Guest",
          companyName: data.companyName || "Presentation Hub",
          representativeName: data.representativeName || "your representative",
          videoTitle: data.videoTitle || "Presentation",
          estimatedDurationLabel:
            data.estimatedDurationLabel || "Approximately 10–15 minutes",
          legalDocuments: data.legalDocuments || [],
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
    if (!welcome || continuing) return;
    setContinuing(true);
    navigate(`/p/${welcome.sessionId}`, { replace: true });
  }

  if (phase === "loading") {
    return (
      <div className="client-shell">
        <div className="panel client-panel invite-loading-panel">
          <p className="eyebrow">Secure Invitation</p>
          <h1>Loading your presentation...</h1>
          <div className="invite-spinner" role="status" aria-label="Loading" />
          <p className="muted small">
            Verifying your invitation, company, presentation, and legal documents.
          </p>
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

  if (phase === "welcome" && welcome) {
    return (
      <div className="client-shell">
        <div className="panel client-panel">
          <p className="eyebrow">Secure Invitation</p>
          <h1>Welcome {welcome.clientName}</h1>
          <p className="invite-company">{welcome.companyName}</p>
          <p>
            Your representative has securely shared a presentation with you.
          </p>
          <p>
            Before continuing you must review and accept the required legal
            documents.
          </p>
          <p className="muted">
            Estimated viewing time:
            <br />
            <strong>{welcome.estimatedDurationLabel}</strong>
          </p>
          <button
            type="button"
            className="invite-continue-btn"
            disabled={continuing}
            onClick={onContinue}
          >
            {continuing ? "Continuing…" : "Continue"}
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
