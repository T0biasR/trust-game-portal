import { getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import { getAuth } from "firebase-admin/auth";

type ArchiveObjects = { jsonObject: string; tsvObject: string };

export function getFirebaseAdminApp() {
  if (!process.env.FIREBASE_PROJECT_ID && !process.env.GOOGLE_CLOUD_PROJECT) return null;
  const app = getApps()[0] ?? initializeApp({
    credential: applicationDefault(),
    projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
  return app;
}

function bucket() {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  const app = getFirebaseAdminApp();
  if (!bucketName || !app) return null;
  return getStorage(app).bucket(bucketName);
}

export async function verifyResearcherIdToken(token: string) {
  const app = getFirebaseAdminApp();
  if (!app) return null;
  const allowed = new Set((process.env.RESEARCHER_ACCOUNT_EMAILS ?? "")
    .split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
  if (!allowed.size) return null;
  try {
    const decoded = await getAuth(app).verifyIdToken(token);
    const email = decoded.email?.toLowerCase();
    const secondFactor = (decoded.firebase as { sign_in_second_factor?: string } | undefined)?.sign_in_second_factor;
    if (!email || !decoded.email_verified || !allowed.has(email) || secondFactor !== "totp") return null;
    return email;
  } catch {
    return null;
  }
}

export function trialRowsTsv(data: { trialRows?: Array<Record<string, unknown>> }) {
  const rows = data.trialRows ?? [];
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const quote = (value: unknown) => {
    const stringValue = value === null || value === undefined ? "" :
      typeof value === "string" ? value : JSON.stringify(value);
    return `"${stringValue.replaceAll('"', '""')}"`;
  };
  return [columns.join("\t"), ...rows.map((row) => columns.map((key) => quote(row[key])).join("\t"))].join("\n");
}

export async function uploadResearchArchive(
  runId: string,
  data: Record<string, unknown> & { trialRows?: Array<Record<string, unknown>> },
): Promise<ArchiveObjects | null> {
  const storageBucket = bucket();
  if (!storageBucket) return null;
  const jsonObject = `research-exports/${runId}/participant.json`;
  const tsvObject = `research-exports/${runId}/trials.tsv`;
  const metadata = {
    cacheControl: "private, no-store",
    metadata: { runId, schemaVersion: String(data.schemaVersion ?? "unknown") },
  };
  await Promise.all([
    storageBucket.file(jsonObject).save(JSON.stringify(data, null, 2), {
      ...metadata, contentType: "application/json; charset=utf-8", resumable: false,
    }),
    storageBucket.file(tsvObject).save(trialRowsTsv(data), {
      ...metadata, contentType: "text/tab-separated-values; charset=utf-8", resumable: false,
    }),
  ]);
  return { jsonObject, tsvObject };
}

export async function downloadResearchArchive(objectName: string) {
  const storageBucket = bucket();
  if (!storageBucket) return null;
  const file = storageBucket.file(objectName);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [contents] = await file.download();
  return contents;
}
