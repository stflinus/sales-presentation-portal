import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  ACCESS_POLICY,
  DEFAULT_ACCESS_DURATION_DAYS,
  clampAccessDurationDays,
  normalizeAccessPolicy,
  type AccessPolicy,
  type InvitationAccessPolicySnapshot,
  type UserPresentationSettings,
  type UserProfile,
  VIDEO_STATUS,
} from "../shared";
import { db } from "./firebase";
import { getActiveVideoForCompany, getCompany } from "./settings";
import { computeInvitationExpiresAtIso } from "./presentationPolicy.pure";

export {
  capSignedUrlExpiresAtMs,
  computeInvitationExpiresAtIso,
  deviceResetMustNotTouch,
  DEVICE_RESET_SAFE_FIELD_PREFIXES,
  genericAccessUnavailableMessage,
  REP_PRESENTATION_CONFIG_ERROR,
  sessionAccessPolicy,
  sessionIsExpired,
  sessionSingleViewBlocked,
  sessionViewingEntitlementConsumed,
  shouldConsumeViewingEntitlementOnCompletion,
} from "./presentationPolicy.pure";

export function readUserPresentationSettings(
  profile: UserProfile,
): UserPresentationSettings | null {
  return profile.presentationSettings ?? null;
}

async function loadSelectableVideo(videoId: string, companyId: string) {
  const snap = await db.collection("videos").doc(videoId).get();
  if (!snap.exists) {
    throw new HttpsError(
      "failed-precondition",
      "Assigned presentation video is not available. Please contact an administrator.",
    );
  }
  const data = snap.data()!;
  if (
    data.deleted === true ||
    data.status === VIDEO_STATUS.DELETED ||
    data.status === VIDEO_STATUS.ARCHIVED ||
    data.archived === true ||
    data.isPlaceholder === true
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Assigned presentation video is not available. Please contact an administrator.",
    );
  }
  if (data.status !== VIDEO_STATUS.ACTIVE || data.active !== true) {
    throw new HttpsError(
      "failed-precondition",
      "Assigned presentation video is not active. Please contact an administrator.",
    );
  }
  if (data.companyId && data.companyId !== companyId) {
    throw new HttpsError(
      "failed-precondition",
      "Assigned presentation video does not belong to this company.",
    );
  }
  return { id: snap.id, ...data };
}

/**
 * Resolve effective presentation settings for a NEW invitation.
 * Policy + expiresAt are snapshotted at creation — the access clock starts here
 * (create/send), not at link open, OTP, legal acceptance, or playback.
 * Does not accept per-invite policy overrides from the representative.
 */
export async function resolveInvitationPolicy(input: {
  profile: UserProfile;
  companyId: string;
  /** Optional clock for tests; defaults to Date.now(). */
  nowMs?: number;
}): Promise<InvitationAccessPolicySnapshot & { videoTitle: string }> {
  const company = await getCompany(input.companyId);
  const settings = readUserPresentationSettings(input.profile);
  const accessPolicy = normalizeAccessPolicy(settings?.accessPolicy);
  const accessDurationDays =
    accessPolicy === ACCESS_POLICY.SINGLE_VIEW
      ? null
      : clampAccessDurationDays(
          settings?.accessDurationDays ?? DEFAULT_ACCESS_DURATION_DAYS,
        );

  let videoId = String(settings?.activeVideoId || "").trim();
  let videoTitle = "Presentation";
  if (videoId) {
    const video = await loadSelectableVideo(videoId, input.companyId);
    videoTitle = String((video as Record<string, unknown>).title || videoTitle);
  } else {
    const fallback = await getActiveVideoForCompany(input.companyId);
    videoId = fallback.id;
    videoTitle = String((fallback as Record<string, unknown>).title || videoTitle);
  }

  const now = input.nowMs ?? Date.now();
  const policyAppliedAt = new Date(now).toISOString();
  const expiresAt = computeInvitationExpiresAtIso({
    accessPolicy,
    accessDurationDays,
    createdAtMs: now,
    companyDefaultInviteTtlHours: company.defaultInviteTtlHours || 168,
  });

  return {
    videoId,
    accessPolicy,
    accessDurationDays,
    expiresAt,
    policyAppliedAt,
    videoTitle,
  };
}

export function expiresAtTimestamp(iso: string): Timestamp {
  return Timestamp.fromDate(new Date(iso));
}

export async function listActiveVideosForCompany(companyId: string) {
  const snap = await db
    .collection("videos")
    .where("companyId", "==", companyId)
    .where("status", "==", VIDEO_STATUS.ACTIVE)
    .get();
  return snap.docs
    .map((d) => {
      const data = d.data();
      if (data.active !== true || data.isPlaceholder || data.deleted || data.archived) {
        return null;
      }
      return {
        id: d.id,
        title: String(data.title || d.id),
        companyId: String(data.companyId || companyId),
      };
    })
    .filter(Boolean) as Array<{ id: string; title: string; companyId: string }>;
}

export async function validateAdminPresentationSettings(input: {
  companyId: string;
  activeVideoId?: string | null;
  accessPolicy?: AccessPolicy | string | null;
  accessDurationDays?: number | null;
}): Promise<UserPresentationSettings> {
  const accessPolicy = normalizeAccessPolicy(input.accessPolicy);
  const activeVideoId = String(input.activeVideoId || "").trim() || null;
  if (activeVideoId) {
    await loadSelectableVideo(activeVideoId, input.companyId);
  }
  const accessDurationDays =
    accessPolicy === ACCESS_POLICY.SINGLE_VIEW
      ? null
      : clampAccessDurationDays(
          input.accessDurationDays ?? DEFAULT_ACCESS_DURATION_DAYS,
        );
  return {
    activeVideoId,
    accessPolicy,
    accessDurationDays,
  };
}
