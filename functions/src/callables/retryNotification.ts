import { onCall, HttpsError } from "firebase-functions/v2/https";
import type { DocumentSnapshot } from "firebase-admin/firestore";
import { NOTIFICATION_STATUS, PERMISSIONS } from "../shared";
import {
  assertHasPermission,
  assertSessionCompanyAccess,
  loadStaffContext,
} from "../lib/authz";
import { db } from "../lib/firebase";
import { notificationService } from "../lib/notifications/NotificationService";

/**
 * Retry email delivery for an existing invitation.
 * Never creates a duplicate invitation — reuses the same invite + secure link.
 */
export const retryInvitationNotification = onCall(async (request) => {
  const ctx = await loadStaffContext(request);
  assertHasPermission(ctx, PERMISSIONS.INVITES_CREATE);

  const inviteId = String(request.data?.inviteId || "").trim();
  const notificationIdInput = String(request.data?.notificationId || "").trim();
  if (!inviteId && !notificationIdInput) {
    throw new HttpsError(
      "invalid-argument",
      "inviteId or notificationId required.",
    );
  }

  let notificationId = notificationIdInput;
  let inviteSnap: DocumentSnapshot | null = null;

  if (inviteId) {
    inviteSnap = await db.collection("invites").doc(inviteId).get();
    if (!inviteSnap.exists) throw new HttpsError("not-found", "Invite not found.");
    const invite = inviteSnap.data()!;
    if (invite.createdBy !== ctx.uid && !ctx.isPlatformAdmin) {
      throw new HttpsError("permission-denied", "Not your invitation.");
    }
    if (invite.companyId) {
      await assertSessionCompanyAccess(ctx, {
        representativeId: invite.createdBy,
        companyId: invite.companyId,
      });
    }
    notificationId = String(invite.lastNotificationId || notificationId || "");
  }

  if (!notificationId) {
    throw new HttpsError(
      "failed-precondition",
      "No notification recorded for this invitation.",
    );
  }

  const noteSnap = await db.collection("notifications").doc(notificationId).get();
  if (!noteSnap.exists) {
    throw new HttpsError("not-found", "Notification not found.");
  }
  const note = noteSnap.data()!;

  if (!ctx.isPlatformAdmin) {
    if (note.representativeId !== ctx.uid) {
      throw new HttpsError("permission-denied", "Not your notification.");
    }
  }

  if (note.status === NOTIFICATION_STATUS.SENT) {
    return {
      inviteId: note.inviteId,
      notificationId,
      notificationStatus: NOTIFICATION_STATUS.SENT,
      emailSent: true,
      failureReason: null,
      message: "Invitation email already delivered.",
    };
  }

  if (!note.secureLink) {
    throw new HttpsError(
      "failed-precondition",
      "Secure link unavailable for retry. Create a new invitation.",
    );
  }

  const delivery = await notificationService.dispatch(notificationId, {
    incrementRetry: true,
  });

  return {
    inviteId: note.inviteId,
    sessionId: note.sessionId,
    notificationId: delivery.notificationId,
    notificationStatus: delivery.status,
    notificationProvider: delivery.provider,
    failureReason: delivery.failureReason,
    inviteStatus: delivery.inviteStatus,
    emailSent: delivery.status === NOTIFICATION_STATUS.SENT,
    inviteUrl: note.secureLink || null,
    retryCount: (Number(note.retryCount || 0) || 0) + 1,
  };
});
