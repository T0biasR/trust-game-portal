import { getApps, initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInAnonymously, type User } from "firebase/auth";
import { collection, doc, getFirestore, connectFirestoreEmulator, serverTimestamp, writeBatch } from "firebase/firestore";
import { getToken as getAppCheckToken, initializeAppCheck, ReCaptchaEnterpriseProvider, type AppCheck } from "firebase/app-check";
import type { ResearchEvent } from "./api";

let userPromise: Promise<User> | null = null;
let emulatorConnected = false;
let appCheckClient: AppCheck | null = null;

function firebaseClients() {
  const config = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  };
  if (Object.values(config).some((value) => !value)) {
    throw new Error("Firebase Web App configuration is missing. Configure the public VITE_FIREBASE_* settings.");
  }
  const app = getApps()[0] ?? initializeApp(config);
  const auth = getAuth(app);
  const firestore = getFirestore(app);
  const appCheckSiteKey = import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY;
  if (appCheckSiteKey && !appCheckClient) {
    appCheckClient = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }
  if (!emulatorConnected) {
    const authEmulator = import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_URL;
    const firestoreEmulator = import.meta.env.VITE_FIRESTORE_EMULATOR_URL;
    if (authEmulator) connectAuthEmulator(auth, authEmulator, { disableWarnings: true });
    if (firestoreEmulator) {
      const url = new URL(firestoreEmulator);
      connectFirestoreEmulator(firestore, url.hostname, Number(url.port || 8080));
    }
    emulatorConnected = true;
  }
  return { auth, firestore };
}

/** Give each participant a persistent, pseudonymous Firebase identity. */
export async function ensureParticipantFirebaseUser() {
  const { auth } = firebaseClients();
  if (auth.currentUser) return auth.currentUser;
  userPromise ??= signInAnonymously(auth)
    .then((credential) => credential.user)
    .catch((error) => {
      userPromise = null;
      throw error;
    });
  return userPromise;
}

export async function participantFirebaseIdToken() {
  const user = await ensureParticipantFirebaseUser();
  return user.getIdToken();
}

/** Optional production anti-abuse token; enforce only after App Check is configured. */
export async function participantAppCheckToken() {
  firebaseClients();
  const siteKey = import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY;
  if (!siteKey || !appCheckClient) return null;
  await ensureParticipantFirebaseUser();
  return (await getAppCheckToken(appCheckClient)).token;
}

/**
 * Persist the participant's task event directly from the browser to Firestore.
 * The server-created run document and Firestore rules bind writes to this
 * anonymous Firebase UID. Events are immutable and idempotent on retry.
 */
export async function saveParticipantEvents(runId: string, events: ResearchEvent[]) {
  if (!events.length) return;
  const { firestore } = firebaseClients();
  const user = await ensureParticipantFirebaseUser();
  const batch = writeBatch(firestore);
  const eventCollection = collection(firestore, "study_runs", runId, "trial_events");
  for (const event of events) {
    const eventRef = doc(eventCollection, event.eventId);
    batch.set(eventRef, {
      sequence: event.sequence,
      event_id: event.eventId,
      event_type: event.eventType,
      trial_id: event.trialId ?? null,
      client_time_ms: event.clientTimeMs,
      payload: event.payload,
      participant_auth_uid: user.uid,
      server_time: serverTimestamp(),
    });
  }
  await batch.commit();
}
