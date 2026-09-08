/**
 * One-shot: publish NDA v1.1.0 plain-text body to Firestore for serenity-1
 * and activate it (archives prior active NDA). Uses Admin SDK.
 *
 * Run: node scripts/publish-nda-v1.1.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// Load plain text by evaluating the TS export via dynamic import after build,
// or embed by reading the source file between markers.
const versionsSrc = readFileSync(
  new URL("../src/modules/legal/nda/versions.ts", import.meta.url),
  "utf8",
);
const match = versionsSrc.match(
  /export const NDA_V1_1_PLAIN_TEXT = `([\s\S]*?)`;/,
);
if (!match) {
  console.error("Could not find NDA_V1_1_PLAIN_TEXT in versions.ts");
  process.exit(1);
}
const body = match[1];
const contentSha256 = createHash("sha256").update(body, "utf8").digest("hex");

initializeApp({
  credential: applicationDefault(),
  projectId: "sales-presentation-portal",
});
const db = getFirestore();
const companyId = "serenity-1";
const type = "nda";
const title = "NON-DISCLOSURE AND LIABILITY WAIVER AGREEMENT";
const versionLabel = "1.1.0";
const effectiveDate = "2026-09-08";
const originalPdfPath = "/legal/nda/v1.1.0/Serenity-1-Consulting-NDA.pdf";
const uid = "system-publish-nda-v1.1.0";

const ref = db.collection("legalDocuments").doc();
const nowIso = new Date().toISOString();

await db.runTransaction(async (tx) => {
  const active = await tx.get(
    db
      .collection("legalDocuments")
      .where("type", "==", type)
      .where("companyId", "==", companyId)
      .where("status", "==", "active")
      .limit(20),
  );
  let previousVersionId = null;
  for (const doc of active.docs) {
    previousVersionId = previousVersionId || doc.id;
    tx.update(doc.ref, {
      status: "archived",
      active: false,
      archivedAt: nowIso,
      updatedAt: nowIso,
      updatedAtServer: FieldValue.serverTimestamp(),
    });
  }

  tx.set(ref, {
    type,
    title,
    body,
    versionLabel,
    contentSha256,
    companyId,
    status: "active",
    active: true,
    createdAt: nowIso,
    createdBy: uid,
    activatedAt: nowIso,
    effectiveDate,
    previousVersionId,
    originalPdfPath,
    createdAtServer: FieldValue.serverTimestamp(),
  });

  tx.set(
    db.collection("settings").doc("portal"),
    { activeNdaId: ref.id, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  tx.set(
    db.collection("companies").doc(companyId),
    {
      activeNdaId: ref.id,
      updatedAt: nowIso,
      updatedAtServer: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
});

console.log(
  JSON.stringify(
    { ok: true, id: ref.id, contentSha256, companyId, versionLabel },
    null,
    2,
  ),
);
