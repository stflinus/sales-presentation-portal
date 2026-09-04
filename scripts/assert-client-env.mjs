#!/usr/bin/env node
const required = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
];
const missing = required.filter((k) => !process.env[k] || !String(process.env[k]).trim());
// Also load .env if present (vite loads it; this script may run before)
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
function loadEnvFile(name) {
  const p = resolve(process.cwd(), name);
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (process.env[m[1]] == null || process.env[m[1]] === "") {
      process.env[m[1]] = m[2];
    }
  }
}
loadEnvFile(".env");
loadEnvFile(".env.production");
loadEnvFile(".env.local");
const stillMissing = required.filter((k) => !process.env[k] || !String(process.env[k]).trim());
if (stillMissing.length) {
  console.error(
    `Refusing to build: missing ${stillMissing.join(", ")}. Copy .env.example → .env and fill Firebase web config.`,
  );
  process.exit(1);
}
if (process.env.VITE_USE_EMULATORS === "true") {
  console.error("Refusing production build with VITE_USE_EMULATORS=true");
  process.exit(1);
}
console.log("Client env OK for production build.");
