import { useEffect, useState } from "react";
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type Timestamp,
} from "firebase/firestore";
import { PERMISSIONS, type PresentationSession } from "@spp/shared";
import { db } from "@/lib/firebase";
import { useAuth } from "@/modules/auth/AuthProvider";

function normalizeSession(
  id: string,
  data: Record<string, unknown>,
): PresentationSession {
  const ts = (value: unknown) => {
    if (!value) return undefined;
    if (typeof value === "string") return value;
    if (typeof value === "object" && value && "toDate" in value) {
      return (value as Timestamp).toDate().toISOString();
    }
    return undefined;
  };

  return {
    id,
    inviteId: String(data.inviteId || ""),
    representativeId: String(data.representativeId || ""),
    representativeName: String(data.representativeName || ""),
    clientName: String(data.clientName || ""),
    clientEmail: String(data.clientEmail || ""),
    status: data.status as PresentationSession["status"],
    videoId: String(data.videoId || ""),
    companyId: String(data.companyId || ""),
    contactId: (data.contactId as string | null | undefined) ?? null,
    legalAcceptanceId: data.legalAcceptanceId as string | undefined,
    ndaVersionId: data.ndaVersionId as string | undefined,
    termsVersionId: data.termsVersionId as string | undefined,
    privacyVersionId: data.privacyVersionId as string | undefined,
    viewingDeviceId: data.viewingDeviceId as string | undefined,
    maxWatchedSeconds: Number(data.maxWatchedSeconds || 0),
    completionPercent: Number(data.completionPercent || 0),
    completedAt: ts(data.completedAt) || (data.completedAt as string | undefined),
    closedAt: ts(data.closedAt) || (data.closedAt as string | undefined),
    expiresAt: String(data.expiresAt || ""),
    representativeNotes: String(data.representativeNotes || ""),
    followUpStatus: data.followUpStatus as PresentationSession["followUpStatus"],
    followUpAt: (data.followUpAt as string | null | undefined) || undefined,
    followUpDate: (data.followUpDate as string | null | undefined) || undefined,
    followUpTime: (data.followUpTime as string | null | undefined) || undefined,
    followUpCalendarEventId:
      (data.followUpCalendarEventId as string | null | undefined) || undefined,
    followUpReminderStatus:
      (data.followUpReminderStatus as PresentationSession["followUpReminderStatus"]) ||
      undefined,
    followUpNotes: (data.followUpNotes as string | null | undefined) || undefined,
    followUpId: (data.followUpId as string | null | undefined) || undefined,
    inviteUrl: (data.inviteUrl as string | null | undefined) || undefined,
    healthStatus:
      (data.healthStatus as PresentationSession["healthStatus"]) || "healthy",
    healthSummary: (data.healthSummary as string | null | undefined) || null,
    healthUpdatedAt:
      (data.healthUpdatedAt as string | null | undefined) || null,
    salesOutcome: (data.salesOutcome as PresentationSession["salesOutcome"]) || null,
    analytics: (data.analytics as PresentationSession["analytics"]) || {},
    createdAt: String(data.createdAt || ""),
    updatedAt: String(data.updatedAt || ""),
  };
}

/**
 * Live presentation sessions scoped by role (enforced also by Firestore rules).
 * Representative: own only. Manager: company. Platform Admin: all (capped).
 */
export function useDashboardSessions() {
  const { user, permissions, companyId, isPlatformAdmin } = useAuth();
  const canReadCompany = permissions.includes(PERMISSIONS.SESSIONS_READ_COMPANY);
  const canAdmin =
    isPlatformAdmin || permissions.includes(PERMISSIONS.ADMIN_ACCESS);
  const [sessions, setSessions] = useState<PresentationSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;

    let q;
    if (canAdmin) {
      q = query(
        collection(db, "presentationSessions"),
        orderBy("updatedAt", "desc"),
        limit(500),
      );
    } else if (canReadCompany && companyId) {
      q = query(
        collection(db, "presentationSessions"),
        where("companyId", "==", companyId),
        orderBy("updatedAt", "desc"),
        limit(500),
      );
    } else {
      q = query(
        collection(db, "presentationSessions"),
        where("representativeId", "==", user.uid),
        orderBy("updatedAt", "desc"),
        limit(500),
      );
    }

    const unsub = onSnapshot(
      q,
      (snap) => {
        setSessions(
          snap.docs.map((doc) =>
            normalizeSession(doc.id, doc.data() as Record<string, unknown>),
          ),
        );
        setLoading(false);
        setError(null);
      },
      (err) => {
        setError(
          "We're sorry, but there was a problem loading presentations. Please try again or contact an administrator.",
        );
        void err;
        setLoading(false);
      },
    );
    return unsub;
  }, [user, companyId, canReadCompany, canAdmin]);

  return { sessions, loading, error };
}

/** @deprecated use useDashboardSessions */
export function useRepSessions() {
  return useDashboardSessions();
}
