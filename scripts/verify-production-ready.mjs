#!/usr/bin/env node
/**
 * Static production readiness checks (no Firebase deploy).
 * Exit 1 if blockers are found in local workspace configuration.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const blockers = [];
const warnings = [];

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

// Rules must deny Storage SDK access
const storageRules = read("storage.rules");
if (!/allow read, write: if false/.test(storageRules)) {
  blockers.push("storage.rules does not deny all client SDK read/write");
}

const firestoreRules = read("firestore.rules");
if (!/legalAcceptances/.test(firestoreRules) || !/allow create, update, delete: if false/.test(firestoreRules)) {
  blockers.push("firestore.rules must deny SDK writes to legalAcceptances");
}
if (!/viewingLeases/.test(firestoreRules)) {
  blockers.push("firestore.rules missing viewingLeases deny rules");
}

const firebaserc = read(".firebaserc");
if (firebaserc.includes("REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID")) {
  blockers.push(".firebaserc still has placeholder project id");
}

if (!existsSync(resolve(root, ".env"))) {
  warnings.push(".env missing (required before production build/deploy)");
} else {
  const env = read(".env");
  if (/VITE_USE_EMULATORS\s*=\s*true/.test(env)) {
    blockers.push(".env enables VITE_USE_EMULATORS=true");
  }
  if (!/VITE_FIREBASE_PROJECT_ID=\S+/.test(env)) {
    blockers.push(".env missing VITE_FIREBASE_PROJECT_ID");
  }
  if (!/VITE_USE_APP_CHECK\s*=\s*true/.test(env)) {
    warnings.push(
      "TEMPORARY SECURITY EXCEPTION: App Check not enabled in .env (see docs/APP_CHECK.md)",
    );
  }
}

console.log("Production readiness (static)\n");
if (blockers.length) {
  console.log("BLOCKERS:");
  blockers.forEach((b) => console.log(`  ✗ ${b}`));
}
if (warnings.length) {
  console.log("WARNINGS:");
  warnings.forEach((w) => console.log(`  ! ${w}`));
}
if (!blockers.length) {
  console.log("No static blockers in workspace rules/config placeholders.");
}
console.log(
  "\nNote: Published legal docs, active video, and SMTP secrets are validated at runtime via validateProductionReadiness / createInvite guards.",
);

process.exit(blockers.length ? 1 : 0);
