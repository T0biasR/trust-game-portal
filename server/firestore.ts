import {
  applicationDefault,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/**
 * Initialize the server-only Firestore client.
 *
 * Production should use Application Default Credentials. On hroot this means
 * either a workload identity configured by the university or a protected
 * service-account credential file referenced by GOOGLE_APPLICATION_CREDENTIALS.
 * Never pass credentials to the browser or check a key into source control.
 *
 * Local tests can point FIRESTORE_EMULATOR_HOST at the Firestore emulator; in
 * that case no Google credential is required and all data stays in the emulator.
 */
export function createFirestore(): Firestore {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  if (!projectId) {
    throw new Error("FIREBASE_PROJECT_ID is required for the Firestore server.");
  }

  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST?.trim();
  if (isProduction() && emulatorHost && process.env.FUNCTIONS_EMULATOR !== "true") {
    throw new Error("Production must not connect to the Firestore Emulator.");
  }
  if (projectId.startsWith("demo-") && !emulatorHost) {
    throw new Error("A demo Firebase project ID requires FIRESTORE_EMULATOR_HOST; refusing to connect to Google Cloud.");
  }

  if (getApps().length === 0) {
    initializeApp(
      emulatorHost
        ? { projectId }
        : { credential: applicationDefault(), projectId },
    );
  }

  return getFirestore();
}

function isProduction() {
  return process.env.NODE_ENV === "production";
}

/** A read-only readiness probe; it does not create or modify study data. */
export async function checkFirestoreReady(firestore: Firestore): Promise<void> {
  await firestore.collection("_health").doc("connectivity").get();
}
