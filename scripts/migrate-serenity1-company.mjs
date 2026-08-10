/**
 * One-time migration: create Serenity 1 company, backfill companyId, migrate admin claims.
 * Usage: node scripts/migrate-serenity1-company.mjs
 */
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const PROJECT_ID = "sales-presentation-portal";
const COMPANY_ID = "serenity-1";
const COMPANY_NAME = "Serenity 1";

initializeApp({
  credential: applicationDefault(),
  projectId: PROJECT_ID,
});

const db = getFirestore();
const auth = getAuth();

const PLATFORM_ADMIN_PERMISSIONS = [
  "dashboard:read",
  "invites:create",
  "invites:revoke_own",
  "sessions:read_own",
  "sessions:read_company",
  "sessions:note_own",
  "sessions:reset_own",
  "sessions:reset_company",
  "followups:manage_own",
  "followups:read_company",
  "calendar:connect_own",
  "admin:access",
  "companies:manage",
  "legal:manage",
  "videos:manage",
  "users:manage",
  "users:manage_company",
  "settings:manage",
  "audit:read_company",
  "audit:read_all",
];

const ROLE_PERMISSIONS = {
  representative: [
    "dashboard:read",
    "invites:create",
    "invites:revoke_own",
    "sessions:read_own",
    "sessions:note_own",
    "followups:manage_own",
    "calendar:connect_own",
  ],
  manager: [
    "dashboard:read",
    "invites:create",
    "invites:revoke_own",
    "sessions:read_own",
    "sessions:read_company",
    "sessions:note_own",
    "sessions:reset_company",
    "followups:manage_own",
    "followups:read_company",
    "users:manage_company",
    "audit:read_company",
  ],
  administrator: PLATFORM_ADMIN_PERMISSIONS,
  owner: PLATFORM_ADMIN_PERMISSIONS,
  client: ["sessions:read_own", "legal:accept_own", "video:view_own"],
};

async function syncClaims(uid, data) {
  const roleIds = data.roleIds || [];
  const rolePrimary = data.primaryRole || roleIds[0] || "representative";
  const permissions =
    Array.isArray(data.permissions) && data.permissions.length
      ? data.permissions
      : ROLE_PERMISSIONS[rolePrimary] || [];
  await auth.setCustomUserClaims(uid, {
    rolePrimary,
    roleIds,
    permissions,
    companyId: data.companyId ?? null,
    ver: Date.now(),
  });
}

async function backfillCollection(name, companyId, { skip } = {}) {
  const snap = await db.collection(name).get();
  let updated = 0;
  let skipped = 0;
  let batch = db.batch();
  let ops = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.companyId) continue;
    if (skip && skip(data)) {
      skipped += 1;
      continue;
    }
    batch.update(doc.ref, { companyId });
    updated += 1;
    ops += 1;
    if (ops >= 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return { total: snap.size, updated, skipped };
}

async function main() {
  const settingsRef = db.collection("settings").doc("portal");
  const settingsSnap = await settingsRef.get();
  if (!settingsSnap.exists) {
    throw new Error("Portal settings missing. Bootstrap first.");
  }
  const settings = settingsSnap.data();

  // Resolve admin actor for createdBy
  const usersSnap = await db.collection("users").get();
  let adminUid = "migration";
  for (const doc of usersSnap.docs) {
    const roles = doc.data().roleIds || [];
    if (roles.includes("administrator") || roles.includes("owner")) {
      adminUid = doc.id;
      break;
    }
  }

  const companyRef = db.collection("companies").doc(COMPANY_ID);
  const companySnap = await companyRef.get();
  const nowIso = new Date().toISOString();

  if (!companySnap.exists) {
    await companyRef.set({
      id: COMPANY_ID,
      name: COMPANY_NAME,
      status: "active",
      createdAt: nowIso,
      createdBy: adminUid,
      updatedAt: nowIso,
      branding: {
        primaryColor: null,
        logoUrl: null,
        displayName: null,
      },
      activeNdaId: settings.activeNdaId || "",
      activeTermsId: settings.activeTermsId || "",
      activePrivacyId: settings.activePrivacyId || "",
      activeVideoId: settings.activeVideoId || "",
      managerIds: [],
      representativeIds: [],
      defaultInviteTtlHours: settings.defaultInviteTtlHours || 168,
      createdAtServer: FieldValue.serverTimestamp(),
      updatedAtServer: FieldValue.serverTimestamp(),
    });
    console.log(`Created company ${COMPANY_ID} (${COMPANY_NAME})`);
  } else {
    await companyRef.set(
      {
        activeNdaId: companySnap.data().activeNdaId || settings.activeNdaId || "",
        activeTermsId:
          companySnap.data().activeTermsId || settings.activeTermsId || "",
        activePrivacyId:
          companySnap.data().activePrivacyId || settings.activePrivacyId || "",
        activeVideoId:
          companySnap.data().activeVideoId || settings.activeVideoId || "",
        updatedAt: nowIso,
        updatedAtServer: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    console.log(`Company ${COMPANY_ID} already exists — refreshed active content pointers`);
  }

  await settingsRef.set(
    {
      defaultCompanyId: COMPANY_ID,
      companyName: settings.companyName || COMPANY_NAME,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  console.log("Set settings.defaultCompanyId =", COMPANY_ID);

  // Seed role docs
  for (const [roleId, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    await db.collection("roles").doc(roleId).set(
      {
        id: roleId,
        name: roleId,
        permissions: [...permissions],
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
  console.log("Synced role permission catalogs");

  const collectionsToBackfill = [
    { name: "legalDocuments" },
    { name: "videos", skip: (data) => data.deleted === true },
    { name: "invites" },
    { name: "presentationSessions" },
    { name: "followUps" },
  ];
  for (const { name, skip } of collectionsToBackfill) {
    const result = await backfillCollection(name, COMPANY_ID, { skip });
    console.log(
      `Backfill ${name}: updated ${result.updated}/${result.total}` +
        (result.skipped ? ` (skipped ${result.skipped} deleted)` : ""),
    );
  }

  // Migrate staff profiles
  for (const doc of usersSnap.docs) {
    const data = doc.data();
    const roleIds = data.roleIds || [];
    const isAdmin =
      roleIds.includes("administrator") || roleIds.includes("owner");
    const primaryRole = isAdmin
      ? "administrator"
      : data.primaryRole || roleIds[0] || "representative";
    const permissions =
      Array.isArray(data.permissions) && data.permissions.length
        ? data.permissions
        : ROLE_PERMISSIONS[primaryRole] || ROLE_PERMISSIONS.representative;
    const companyId = isAdmin ? null : data.companyId || COMPANY_ID;
    const patch = {
      primaryRole,
      permissions,
      companyId,
      status: data.status || "active",
      updatedAt: nowIso,
      updatedAtServer: FieldValue.serverTimestamp(),
    };
    if (!data.createdBy) patch.createdBy = adminUid;
    if (!data.createdAt) patch.createdAt = data.updatedAt || nowIso;
    await doc.ref.set(patch, { merge: true });
    await syncClaims(doc.id, { ...data, ...patch, roleIds });
    console.log(
      `Migrated user ${doc.id} role=${primaryRole} companyId=${companyId}`,
    );

    if (!isAdmin && companyId === COMPANY_ID) {
      const field =
        primaryRole === "manager" ? "managerIds" : "representativeIds";
      await companyRef.set(
        {
          [field]: FieldValue.arrayUnion(doc.id),
          updatedAt: nowIso,
        },
        { merge: true },
      );
    }
  }

  console.log("Migration complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
