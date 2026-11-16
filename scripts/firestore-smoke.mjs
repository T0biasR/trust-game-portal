import "dotenv/config";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
if (!projectId) {
  console.error("FIREBASE_PROJECT_ID is required.");
  process.exit(2);
}

const emulator = process.env.FIRESTORE_EMULATOR_HOST?.trim();
if (!emulator && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error(
    "No server credentials configured. Set GOOGLE_APPLICATION_CREDENTIALS to a protected credential file, or configure ADC/workload identity.",
  );
  process.exit(2);
}

const app = getApps()[0] ?? initializeApp({
  projectId,
  ...(emulator ? {} : { credential: applicationDefault() }),
});

try {
  // Read-only check against a reserved, non-participant path. Never write test
  // documents to a production collection as part of a connectivity check.
  const probe = await getFirestore(app)
    .collection("_health")
    .doc("connectivity")
    .get();
  console.log(
    `Firestore connection OK (project ${projectId}; emulator=${Boolean(emulator)}; probeDocumentExists=${probe.exists}).`,
  );
} catch (error) {
  console.error("Firestore connection failed.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await app.delete();
}
