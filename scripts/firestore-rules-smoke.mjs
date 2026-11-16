import { randomUUID } from "node:crypto";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInAnonymously, signOut } from "firebase/auth";
import { connectFirestoreEmulator, doc, getFirestore, getDoc, serverTimestamp, setDoc } from "firebase/firestore";

const projectId = process.env.FIREBASE_PROJECT_ID;
const apiBase = process.env.API_BASE ?? "http://127.0.0.1:3001";
const authAddress = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const firestoreAddress = process.env.FIRESTORE_EMULATOR_HOST;
const accessCode = process.env.DEV_ACCESS_CODE;
if (!projectId?.startsWith("demo-") || !authAddress || !firestoreAddress || !accessCode) {
  throw new Error("This check requires a demo Firebase project, both emulator hosts, and DEV_ACCESS_CODE.");
}

const app = initializeApp({
  apiKey: "emulator-api-key",
  authDomain: "localhost",
  projectId,
  appId: "1:000000000000:web:emulator",
}, `rules-smoke-${randomUUID()}`);
const auth = getAuth(app);
connectAuthEmulator(auth, `http://${authAddress}`, { disableWarnings: true });
const firestore = getFirestore(app);
const [firestoreHost, firestorePort] = firestoreAddress.split(":");
connectFirestoreEmulator(firestore, firestoreHost, Number(firestorePort || 8080));

const credential = await signInAnonymously(auth);
const firebaseIdToken = await credential.user.getIdToken();
let cookie = "";
async function api(path, body) {
  const response = await fetch(`${apiBase}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "X-Firebase-Id-Token": firebaseIdToken,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

await api("/api/auth/code", { code: accessCode });
await api("/api/participant/consent", { accepted: true, documentVersion: "consent-de-v1" });
const run = await api("/api/runs", {});
await api(`/api/runs/${run.id}/start`, {});

const eventId = randomUUID();
const eventRef = doc(firestore, "study_runs", run.id, "trial_events", eventId);
await setDoc(eventRef, {
  sequence: 0,
  event_id: eventId,
  event_type: "rules_smoke",
  trial_id: null,
  client_time_ms: Date.now(),
  payload: { local_emulator_check: true },
  participant_auth_uid: credential.user.uid,
  server_time: serverTimestamp(),
});

async function expectDenied(label, action) {
  try {
    await action();
    throw new Error(`${label} unexpectedly succeeded`);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("unexpectedly succeeded")) throw error;
    if (error?.code !== "permission-denied") throw error;
  }
}

await expectDenied("Reading a participant event", () => getDoc(eventRef));
await expectDenied("Writing an outcome directly", () => setDoc(
  doc(firestore, "study_runs", run.id, "outcomes", randomUUID()),
  { returned: 1 },
));

await signOut(auth);
const other = await signInAnonymously(auth);
await expectDenied("Cross-participant event write", () => setDoc(
  doc(firestore, "study_runs", run.id, "trial_events", randomUUID()),
  {
    sequence: 1,
    event_id: "cross-participant",
    event_type: "rules_smoke",
    trial_id: null,
    client_time_ms: Date.now(),
    payload: {},
    participant_auth_uid: other.user.uid,
    server_time: serverTimestamp(),
  },
));

console.log(JSON.stringify({
  projectId,
  ownActiveRunEventWrite: "allowed",
  participantEventRead: "denied",
  directOutcomeWrite: "denied",
  crossParticipantEventWrite: "denied",
}, null, 2));
