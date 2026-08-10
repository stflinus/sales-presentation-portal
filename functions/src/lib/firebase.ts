import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

if (getApps().length === 0) {
  initializeApp();
}

export const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });
export const auth = getAuth();

const defaultBucket =
  process.env.STORAGE_BUCKET ||
  process.env.FIREBASE_STORAGE_BUCKET ||
  "sales-presentation-portal.firebasestorage.app";

export const bucket = getStorage().bucket(defaultBucket);
