import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { getApps, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getAppCheck } from "firebase-admin/app-check";
import { getFirestore, FieldPath, type DocumentData, type DocumentSnapshot, type Firestore } from "firebase-admin/firestore";
import {
  DATA_SCHEMA_VERSION, PROTOCOL_VERSION, createTrustSchedule, validateSchedule,
  nextLeastUsedCounterbalanceGroup, makeDevelopmentBank, buildRecordedBank,
  type OutcomeBank, type TrusteePolicy,
} from "../src/shared/protocol.js";
import { createFirestore, checkFirestoreReady } from "./firestore.js";
import { assignWorkflowOrder, validateWorkflowSteps, WORKFLOW_MODULES, type WorkflowStep } from "../src/shared/workflow.js";
import { questionnaireById, validateQuestionnaireResponses } from "../src/shared/questionnaires.js";
import { adminIdentity, checkRateLimit, digest, newCode, newParticipantCode, newToken, normalizeCode, stableJsonHash } from "./security.js";

const SESSION_COOKIE = "research_session";
const isProduction = process.env.NODE_ENV === "production";
const hostedOrigins = new Set((process.env.STUDY_ALLOWED_ORIGINS ?? "").split(",").map((v) => v.trim()).filter(Boolean));
const hostSchema = z.enum(["portal", "jatos", "pavlovia", "github-pages"]);
const app = Fastify({ logger: true, bodyLimit: 2_000_000, trustProxy: true });
const db = createFirestore();
const C = {
  grants: "access_grants", codeIndex: "access_code_index", sessions: "participant_sessions",
  runs: "study_runs", protocols: "protocols", banks: "outcome_banks", workflows: "workflow_definitions",
  prolific: "prolific_studies", prolificSessions: "prolific_session_index", allocators: "counterbalance_allocators",
  audit: "admin_audit",
};
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();
const expiresAt = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
function row<T extends DocumentData = Row>(snap: DocumentSnapshot<T>): (T & { id: string }) | null {
  return snap.exists ? ({ id: snap.id, ...snap.data() } as T & { id: string }) : null;
}
async function list<T extends DocumentData = Row>(query: FirebaseFirestore.Query<T>) {
  const snap = await query.get();
  return snap.docs.map((doc) => row(doc)!);
}
function runRef(runId: string) { return db.collection(C.runs).doc(runId); }
function grantRef(grantId: string) { return db.collection(C.grants).doc(grantId); }
function safeDocId(value: string) { return crypto.createHash("sha256").update(value).digest("hex"); }
function eventRef(runId: string, eventId: string) { return runRef(runId).collection("trial_events").doc(eventId); }
function sequenceRef(runId: string, sequence: number) { return runRef(runId).collection("trial_sequences").doc(String(sequence).padStart(8, "0")); }
function workflowStateRef(runId: string, stepId: string) { return runRef(runId).collection("workflow_steps").doc(stepId); }
function outcomeRef(runId: string, trialId: string) { return runRef(runId).collection("outcomes").doc(safeDocId(trialId)); }
function riskRef(runId: string, trialId: string) { return runRef(runId).collection("risk_resolutions").doc(safeDocId(trialId)); }
function nested(runId: string, name: string) { return runRef(runId).collection(name); }
async function addParticipantEvent(grantId: string, eventType: string, payload: unknown, clientTimeMs: number | null = null) {
  await grantRef(grantId).collection("participant_events").add({ event_type: eventType, payload, client_time_ms: clientTimeMs, server_time: nowIso() });
}
async function getGrantByCode(code: string) {
  const hash = digest(normalizeCode(code));
  const index = row(await db.collection(C.codeIndex).doc(hash).get());
  return index ? row(await grantRef(index.grant_id).get()) : null;
}
async function grantFor(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
  const token = request.cookies[SESSION_COOKIE] ?? bearer;
  if (!token) return null;
  const tokenHash = digest(token);
  const session = row(await db.collection(C.sessions).doc(tokenHash).get());
  if (!session || Date.parse(session.expires_at) <= Date.now()) return null;
  const grant = row(await grantRef(session.access_grant_id).get());
  // Keep completed sessions readable so a participant can safely refresh the
  // confirmation page; mutating endpoints separately enforce run immutability.
  if (!grant || Date.parse(grant.expires_at) <= Date.now() || grant.status === "revoked") return null;
  await db.collection(C.sessions).doc(tokenHash).update({ last_seen_at: nowIso() });
  return grant;
}
async function requireGrant(request: FastifyRequest, reply: any) {
  const grant = await grantFor(request);
  if (!grant) { reply.code(401).send({ error: "Sitzung abgelaufen. Bitte geben Sie Ihren Zugangscode erneut ein." }); return null; }
  return grant;
}
async function requireParticipantFirebaseUid(request: FastifyRequest, reply: any) {
  const token = request.headers["x-firebase-id-token"];
  if (typeof token !== "string" || token.length < 100 || token.length > 10_000) {
    reply.code(401).send({ error: "Participant Firebase identity is missing. Reload the study and try again." });
    return null;
  }
  try {
    const decoded = await getAuth().verifyIdToken(token);
    if (decoded.firebase?.sign_in_provider !== "anonymous") throw new Error("non-anonymous participant identity");
    return decoded.uid;
  } catch {
    reply.code(401).send({ error: "Participant Firebase identity could not be verified. Reload the study and try again." });
    return null;
  }
}
async function requireAdmin(request: FastifyRequest, reply: any) {
  const actor = adminIdentity(request);
  if (!actor) { reply.code(401).send({ error: "Researcher authentication required" }); return null; }
  if (isProduction) {
    const allowlist = new Set((process.env.RESEARCHER_ACCOUNT_EMAILS ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
    if (!allowlist.has(actor.trim().toLowerCase())) { reply.code(403).send({ error: "This researcher account is not authorized." }); return null; }
  }
  return actor;
}
async function audit(actor: string, action: string, detail: unknown) {
  await db.collection(C.audit).add({ actor, action, detail, created_at: nowIso() });
}
function sanitizeRun(run: Row, studyType: string) {
  return { id: run.id, studyType, recruitmentSource: run.recruitment_source ?? "manual", workflowDefinitionId: run.workflow_definition_id ?? null,
    protocolVersion: run.protocol_version, schemaVersion: run.schema_version, scheduleHash: run.schedule_hash,
    outcomeBankVersion: run.outcome_bank_version ?? null, schedule: run.schedule, status: run.status };
}
function completionUrlSchema() {
  return z.string().url().refine((value) => {
    try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "app.prolific.com" && url.pathname === "/submissions/complete" && /^[A-Z0-9]{6,16}$/.test(url.searchParams.get("cc") ?? ""); }
    catch { return false; }
  }, "Use the HTTPS Prolific completion URL for this study.");
}

if (isProduction && (!process.env.CODE_PEPPER || process.env.CODE_PEPPER.length < 32)) throw new Error("Production requires CODE_PEPPER with at least 32 characters.");
if (isProduction && (!process.env.OIDC_PROXY_SECRET || process.env.OIDC_PROXY_SECRET.length < 32)) throw new Error("Production requires OIDC_PROXY_SECRET with at least 32 characters.");
if (isProduction && !process.env.FIREBASE_PROJECT_ID) throw new Error("Production requires FIREBASE_PROJECT_ID.");
if (isProduction && !(process.env.RESEARCHER_ACCOUNT_EMAILS ?? "").split(",").some((email) => email.trim())) throw new Error("Production requires at least one allow-listed researcher account with Firebase TOTP MFA.");

await app.register(cookie);
app.addHook("onRequest", async (request, reply) => {
  const origin = request.headers.origin;
  if (!origin || !hostedOrigins.has(origin)) return;
  reply.header("Access-Control-Allow-Origin", origin); reply.header("Vary", "Origin");
  reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Study-Host, X-Study-Session-Id, X-Study-Deployment-Id, X-Study-Client-Version, X-Firebase-Id-Token, X-Firebase-App-Check");
  reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (request.method === "OPTIONS") return reply.code(204).send();
});
app.addHook("preHandler", async (request, reply) => {
  if (process.env.NODE_ENV !== "production" || process.env.REQUIRE_APP_CHECK !== "true") return;
  if (!request.raw.url?.startsWith("/api/") || request.method === "OPTIONS") return;
  const token = request.headers["x-firebase-app-check"];
  if (typeof token !== "string" || token.length < 20 || token.length > 10_000) {
    return reply.code(401).send({ error: "App verification is required." });
  }
  try {
    await getAppCheck().verifyToken(token);
  } catch {
    return reply.code(401).send({ error: "App verification failed." });
  }
});
app.addHook("onSend", async (request, reply, payload) => {
  reply.header("X-Content-Type-Options", "nosniff"); reply.header("Referrer-Policy", "no-referrer");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (isProduction) reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (request.raw.url?.startsWith("/api/")) reply.header("Cache-Control", "no-store");
  return payload;
});

async function bootstrap() {
  const protocol = db.collection(C.protocols).doc(PROTOCOL_VERSION);
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(protocol);
    if (!existing.exists) tx.create(protocol, { version: PROTOCOL_VERSION, status: "active", configuration: { riskTrials: 0, trustTrials: 72, rewardTrials: 24, punishmentTrials: 24, learningTrials: 24 }, created_at: nowIso() });
  });
  const activeBank = await db.collection(C.banks).where("active", "==", true).limit(1).get();
  if (activeBank.empty && !isProduction) {
    const bank = makeDevelopmentBank();
    await db.collection(C.banks).doc(bank.version).create({ version: bank.version, source: bank.source, content_hash: stableJsonHash(bank), bank, active: true, created_at: nowIso() }).catch(() => undefined);
  }
  if (!isProduction && process.env.DEV_ACCESS_CODE) {
    const code = normalizeCode(process.env.DEV_ACCESS_CODE); const codeHash = digest(code);
    const index = db.collection(C.codeIndex).doc(codeHash); const existing = await index.get();
    if (!existing.exists) {
      const grantId = crypto.randomUUID(); const expiry = expiresAt(30);
      const batch = db.batch(); batch.create(grantRef(grantId), { study_type: "investor", protocol_version: PROTOCOL_VERSION, status: "issued", expires_at: expiry, created_at: nowIso(), recruitment_source: "test" });
      batch.create(index, { grant_id: grantId }); await batch.commit();
    }
  }
}
await bootstrap();

const eventSchema = z.object({ sequence: z.number().int().nonnegative(), eventId: z.string().uuid(), eventType: z.string().min(1).max(80), trialId: z.string().max(80).nullable().optional(), clientTimeMs: z.number().nonnegative(), payload: z.record(z.string(), z.unknown()) });

app.get("/api/admin/session", async (request, reply) => { const actor = await requireAdmin(request, reply); if (!actor) return; return { authenticated: true, researcher: actor }; });
app.get("/api/health", async () => { await checkFirestoreReady(db); return { ok: true, database: "firestore", protocolVersion: PROTOCOL_VERSION }; });

app.post("/api/auth/code", async (request, reply) => {
  const parsed = z.object({ code: z.string().min(8).max(80) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Ungültiges Codeformat." });
  const normalized = normalizeCode(parsed.data.code);
  if (!checkRateLimit(`ip:${request.ip}`, 15, 900_000) || !checkRateLimit(`code:${digest(normalized)}`, 8, 900_000)) return reply.code(429).send({ error: "Zu viele Versuche. Bitte warten Sie und versuchen Sie es später erneut." });
  if (!isProduction && process.env.DEV_ADMIN_TOKEN && normalized === normalizeCode(process.env.DEV_ADMIN_TOKEN)) return { studyType: "admin" as const };
  const grant = await getGrantByCode(normalized);
  if (!grant || Date.parse(grant.expires_at) <= Date.now() || ["revoked", "completed"].includes(grant.status)) return reply.code(401).send({ error: "Der Zugangscode ist ungültig oder nicht mehr aktiv." });
  const token = newToken(); const tokenHash = digest(token); const sessionRef = db.collection(C.sessions).doc(tokenHash); const gRef = grantRef(grant.id); const expiry = new Date(Math.min(Date.parse(grant.expires_at), Date.now() + 12 * 3600_000)).toISOString();
  await db.runTransaction(async (tx) => { const fresh = await tx.get(gRef); if (!fresh.exists || ["revoked", "completed"].includes(fresh.get("status")) || Date.parse(fresh.get("expires_at")) <= Date.now()) throw new Error("grant-inactive"); tx.create(sessionRef, { access_grant_id: grant.id, expires_at: expiry, created_at: nowIso(), last_seen_at: nowIso() }); if (fresh.get("status") === "issued") tx.update(gRef, { status: "active" }); });
  const requestedHost = request.headers["x-study-host"]; const hosted = typeof requestedHost === "string" && hostSchema.safeParse(requestedHost).success && requestedHost !== "portal";
  if (!hosted) reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: isProduction, sameSite: "strict", path: "/", maxAge: 12 * 3600 });
  return { studyType: grant.study_type, protocolVersion: grant.protocol_version, ...(hosted ? { sessionToken: token, host: requestedHost } : {}) };
});

app.post("/api/auth/logout", async (request, reply) => {
  const authorization = request.headers.authorization; const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : null; const token = request.cookies[SESSION_COOKIE] ?? bearer;
  if (token) await db.collection(C.sessions).doc(digest(token)).delete();
  reply.clearCookie(SESSION_COOKIE, { path: "/" }); return { ok: true };
});

app.post("/api/prolific/entry", async (request, reply) => {
  const body = z.object({ prolificPid: z.string().regex(/^[A-Za-z0-9]{24}$/), studyId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).safeParse(request.body);
  if (!body.success) return reply.code(400).send({ error: "Required Prolific study parameters are missing or invalid." });
  if (!checkRateLimit(`prolific:${request.ip}`, 30, 60_000)) return reply.code(429).send({ error: "Too many attempts. Please try again shortly." });
  const mapping = row(await db.collection(C.prolific).doc(body.data.studyId).get());
  const definition = mapping ? row(await db.collection(C.workflows).doc(mapping.workflow_definition_id).get()) : null;
  if (!mapping?.active || !definition || definition.status !== "published") return reply.code(403).send({ error: "This Prolific study is not currently configured." });
  const checked = validateWorkflowSteps(definition.steps);
  if (!checked.ok) return reply.code(503).send({ error: "The configured workflow is not available." });
  const assignedSteps = assignWorkflowOrder(
    checked.steps,
    definition.randomize_task_order === true,
    () => crypto.randomInt(0, 2 ** 32) / 2 ** 32,
  );
  const sessionKey = digest(`${body.data.studyId}:${body.data.sessionId}`); const sessionIndex = db.collection(C.prolificSessions).doc(sessionKey);
  const assignment = await db.runTransaction(async (tx) => {
    const [indexSnap, allocatorSnap] = await Promise.all([tx.get(sessionIndex), tx.get(db.collection(C.allocators).doc(`prolific-${body.data.studyId}`))]);
    if (indexSnap.exists) return { grantId: indexSnap.get("grant_id") as string, created: false };
    const counts = (allocatorSnap.exists ? allocatorSnap.get("counts") : {}) as Record<string, number>;
    const group = nextLeastUsedCounterbalanceGroup(counts); const nextCounts = { ...counts, [group]: (counts[group] ?? 0) + 1 };
    const grantId = crypto.randomUUID(); const codeHash = digest(newToken()); const at = nowIso();
    tx.create(grantRef(grantId), { code_hash: codeHash, study_type: checked.steps.some((s) => s.moduleId === "trust-game") ? "investor" : "workflow", counterbalance_group: group, status: "issued", protocol_version: PROTOCOL_VERSION, expires_at: expiresAt(7), created_at: at, recruitment_source: "prolific", prolific_pid: body.data.prolificPid, prolific_study_id: body.data.studyId, prolific_session_id: body.data.sessionId, workflow_version_id: definition.id, workflow_steps: assignedSteps, workflow_order_randomized: definition.randomize_task_order === true, workflow_order_algorithm: definition.randomize_task_order === true ? "fisher-yates-crypto-v1" : "fixed-definition-order-v1" });
    tx.create(sessionIndex, { grant_id: grantId }); tx.set(db.collection(C.allocators).doc(`prolific-${body.data.studyId}`), { counts: nextCounts, updated_at: at });
    return { grantId, created: true };
  });
  const { grantId, created } = assignment;
  const grant = row(await grantRef(grantId).get());
  if (!grant) throw new Error("Could not initialize the Prolific session.");
  if (grant.prolific_pid !== body.data.prolificPid) return reply.code(409).send({ error: "This Prolific session is already linked to a different participant record." });
  const token = newToken(); const at = nowIso(); const expiry = new Date(Math.min(Date.parse(grant.expires_at), Date.now() + 12 * 3600_000)).toISOString();
  await db.runTransaction(async (tx) => {
    const [g, s] = await Promise.all([tx.get(grantRef(grantId)), tx.get(db.collection(C.sessions).doc(digest(token)))]);
    if (!g.exists || s.exists) throw new Error("Could not create participant session.");
    tx.create(db.collection(C.sessions).doc(digest(token)), { access_grant_id: grantId, expires_at: expiry, created_at: at, last_seen_at: at });
    if (g.get("status") === "issued") tx.update(grantRef(grantId), { status: "active" });
  });
  await addParticipantEvent(grantId, created ? "prolific_entry" : "prolific_entry_resumed", { studyId: body.data.studyId, sessionId: body.data.sessionId, counterbalanceGroup: grant.counterbalance_group, workflowStepIds: (grant.workflow_steps ?? assignedSteps).map((step: WorkflowStep) => step.id), workflowOrderAlgorithm: grant.workflow_order_algorithm ?? (definition.randomize_task_order === true ? "fisher-yates-crypto-v1" : "fixed-definition-order-v1") });
  return { sessionToken: token, recruitmentSource: "prolific", status: grant.status, workflow: { id: definition.id, name: definition.name, version: definition.version, steps: (grant.workflow_steps ?? assignedSteps) as WorkflowStep[], randomizeTaskOrder: definition.randomize_task_order === true, contentHash: definition.content_hash } };
});

app.get("/api/participant/status", async (request, reply) => {
  const grant = await requireGrant(request, reply); if (!grant) return;
  const [consents, runs] = await Promise.all([
    list(grantRef(grant.id).collection("consents").orderBy("recorded_at", "desc").limit(1)),
    list(db.collection(C.runs).where("access_grant_id", "==", grant.id).limit(1)),
  ]);
  const run = runs[0] ?? null;
  if (run) {
    const completion = run.completion ?? null; const bonus = run.bonus ?? null;
    run.completion_code = completion?.completion_code ?? null; run.bonus_eur = bonus?.amount_eur ?? null;
  }
  let workflow: Row | null = null;
  if (grant.workflow_version_id) {
    const definition = row(await db.collection(C.workflows).doc(grant.workflow_version_id).get());
    if (definition) {
      const progress = run ? await list(nested(run.id, "workflow_steps").orderBy(FieldPath.documentId()).limit(100)) : [];
      workflow = { id: definition.id, name: definition.name, version: definition.version, steps: grant.workflow_steps ?? definition.steps, randomizeTaskOrder: definition.randomize_task_order === true, contentHash: definition.content_hash, progress: progress.map((s) => ({ stepId: s.step_id, moduleId: s.module_id, status: s.status, startedAt: s.started_at ?? null, completedAt: s.completed_at ?? null })) };
    }
  }
  const study = grant.recruitment_source === "prolific" ? row(await db.collection(C.prolific).doc(grant.prolific_study_id).get()) : null;
  return { studyType: grant.study_type, status: grant.status, recruitmentSource: grant.recruitment_source ?? "manual", hasFaceSetSelection: Boolean(grant.gender_identity), consented: consents[0]?.accepted === true, consentVersion: consents[0]?.document_version ?? null, run: run ? { id: run.id, status: run.status, protocol_version: run.protocol_version, completion_code: run.completion_code, bonus_eur: run.bonus_eur, workflow_definition_id: run.workflow_definition_id ?? null } : null, workflow, completionRedirectUrl: study?.completion_url ?? null };
});

app.post("/api/participant/consent", async (request, reply) => {
  const grant = await requireGrant(request, reply); if (!grant) return;
  const parsed = z.object({ accepted: z.boolean(), documentVersion: z.enum(["consent-de-v1", "consent-de-v2", "consent-prolific-de-v1"]) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Ungültige Einwilligungsdaten." });
  await grantRef(grant.id).collection("consents").add({ accepted: parsed.data.accepted, document_version: parsed.data.documentVersion, recorded_at: nowIso() });
  return { ok: true };
});

app.post("/api/participant/face-set", async (request, reply) => {
  const grant = await requireGrant(request, reply); if (!grant) return;
  if (grant.recruitment_source !== "prolific") return reply.code(403).send({ error: "This participant question is only available in the Prolific workflow." });
  const body = z.object({ genderIdentity: z.enum(["man", "woman", "nonbinary", "self_described", "prefer_not_to_say"]), faceSetPreference: z.enum(["male", "female", "random"]).optional() }).safeParse(request.body);
  if (!body.success) return reply.code(400).send({ error: "Please choose a response and face-set preference." });
  const needsPreference = !["man", "woman"].includes(body.data.genderIdentity);
  if (needsPreference && !body.data.faceSetPreference) return reply.code(400).send({ error: "A face-set preference is required for this response." });
  const preference = body.data.faceSetPreference ?? (body.data.genderIdentity === "man" ? "male" : "female"); const ref = grantRef(grant.id);
  const accepted = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref); if (!snap.exists) return false;
    const previous = snap.data()!;
    if (previous.gender_identity) return previous.gender_identity === body.data.genderIdentity && previous.face_set_preference === preference;
    tx.update(ref, { gender_identity: body.data.genderIdentity, face_set_preference: preference }); return true;
  });
  if (!accepted) return reply.code(409).send({ error: "This response has already been recorded for this session." });
  if (!grant.gender_identity) await addParticipantEvent(grant.id, "face_set_selection", { genderIdentity: body.data.genderIdentity, faceSetPreference: preference });
  return { ok: true, faceSetPreference: preference };
});

app.post("/api/runs", async (request, reply) => {
  const grant = await requireGrant(request, reply); if (!grant) return;
  const participantAuthUid = await requireParticipantFirebaseUid(request, reply); if (!participantAuthUid) return;
  if (isProduction && process.env.CONSENT_RELEASED !== "true") return reply.code(503).send({ error: "Die Studie ist noch nicht durch die Ethikfreigabe für die Datenerhebung aktiviert." });
  const consents = await list(grantRef(grant.id).collection("consents").orderBy("recorded_at", "desc").limit(1));
  if (consents[0]?.accepted !== true) return reply.code(409).send({ error: "Einwilligung fehlt." });
  const existing = grant.current_run_id
    ? row(await runRef(grant.current_run_id).get())
    : (await list(db.collection(C.runs).where("access_grant_id", "==", grant.id).limit(1)))[0];
  // Runs are immutable protocol snapshots. Never delete a parent run document
  // (Firestore would leave subcollections orphaned); reset development data in
  // the emulator rather than replacing a participant record.
  if (existing) {
    await db.runTransaction(async (tx) => {
      const freshRun = await tx.get(runRef(existing.id));
      if (!freshRun.exists || freshRun.get("access_grant_id") !== grant.id || freshRun.get("status") === "completed") return;
      tx.update(runRef(existing.id), { participant_auth_uid: participantAuthUid });
      if (!grant.current_run_id) tx.set(grantRef(grant.id), { current_run_id: existing.id }, { merge: true });
    });
    return sanitizeRun(existing, grant.study_type);
  }
  const definition = grant.workflow_version_id ? row(await db.collection(C.workflows).doc(grant.workflow_version_id).get()) : null;
  if (grant.workflow_version_id && (!definition || definition.status !== "published")) return reply.code(409).send({ error: "The assigned workflow is no longer available." });
  const workflowSteps = (grant.workflow_steps ?? definition?.steps ?? []) as WorkflowStep[];
  if (grant.recruitment_source === "prolific" && !grant.gender_identity) return reply.code(409).send({ error: "Please complete the face-set question before starting." });
  const hasTrustTask = grant.study_type === "investor" || workflowSteps.some((step) => step.moduleId === "trust-game");
  const seed = newToken(18); const selectedFaceSet = ["male", "female"].includes(grant.face_set_preference) ? grant.face_set_preference : undefined;
  const schedule = hasTrustTask ? createTrustSchedule(seed, { sex: selectedFaceSet ?? (["male", "female"].includes(grant.participant_sex) ? grant.participant_sex : undefined), cbGroup: ["CB1", "CB2", "CB3"].includes(grant.counterbalance_group) ? grant.counterbalance_group : undefined })
    : grant.study_type === "trustee" ? { protocolVersion: "trustee-norming-v1.0.0", investments: Array.from({ length: 11 }, (_, i) => i) }
      : { protocolVersion: `workflow-${grant.workflow_version_id ?? "questionnaire-only"}`, seed, trustTrials: [], riskTrials: [] };
  if (hasTrustTask) { const errors = validateSchedule(schedule as ReturnType<typeof createTrustSchedule>); if (errors.length) throw new Error(`Invalid Trust Game schedule: ${errors.join("; ")}`); }
  const runId = crypto.randomUUID(); const scheduleHash = stableJsonHash(schedule); const requestedHost = request.headers["x-study-host"];
  const host = hostSchema.safeParse(requestedHost).success ? requestedHost as string : "portal";
  const headerValue = (name: string) => { const value = request.headers[name]; return typeof value === "string" && value.length <= 160 ? value : null; };
  const run = { access_grant_id: grant.id, participant_auth_uid: participantAuthUid, study_type: grant.study_type, protocol_version: schedule.protocolVersion, schema_version: DATA_SCHEMA_VERSION, seed, schedule_hash: scheduleHash, outcome_bank_version: hasTrustTask ? "mri-probability-v1" : null, host, host_session_id: headerValue("x-study-session-id"), deployment_id: headerValue("x-study-deployment-id"), client_version: headerValue("x-study-client-version"), schedule, status: "created", started_at: null, completed_at: null, created_at: nowIso(), workflow_definition_id: grant.workflow_version_id ?? null, workflow_steps: workflowSteps, workflow_order_randomized: grant.workflow_order_randomized === true, workflow_order_algorithm: grant.workflow_order_algorithm ?? null, recruitment_source: grant.recruitment_source ?? "manual" };
  const ref = runRef(runId);
  const created = await db.runTransaction(async (tx) => {
    const freshGrant = await tx.get(grantRef(grant.id));
    const priorId = freshGrant.get("current_run_id") as string | undefined;
    if (priorId) {
      const prior = await tx.get(runRef(priorId));
      if (prior.exists) {
        if (prior.get("access_grant_id") !== grant.id || prior.get("status") === "completed") return { id: prior.id, ...prior.data()! };
        tx.update(runRef(priorId), { participant_auth_uid: participantAuthUid });
        return { id: prior.id, ...prior.data()!, participant_auth_uid: participantAuthUid };
      }
    }
    if (!freshGrant.exists || ["revoked", "completed"].includes(freshGrant.get("status"))) return null;
    tx.create(ref, run);
    for (const step of workflowSteps) tx.create(workflowStateRef(runId, step.id), { step_id: step.id, module_id: step.moduleId, required: step.required, status: "not_started", started_at: null, completed_at: null, response: null });
    tx.set(grantRef(grant.id).collection("participant_events").doc(), { event_type: "run_created", payload: { runId, workflowVersionId: grant.workflow_version_id ?? null }, server_time: nowIso() });
    tx.update(grantRef(grant.id), { current_run_id: runId });
    return { id: runId, ...run };
  });
  if (!created) return reply.code(409).send({ error: "This access code is no longer active." });
  return sanitizeRun(created, grant.study_type);
});

app.get("/api/runs/current", async (request, reply) => {
  const grant = await requireGrant(request, reply); if (!grant) return;
  const run = (await list(db.collection(C.runs).where("access_grant_id", "==", grant.id).limit(1)))[0];
  if (!run) return reply.code(404).send({ error: "Kein Durchlauf vorhanden." });
  const events = await list(nested(run.id, "trial_events").orderBy("sequence", "desc").limit(1));
  const completed = await list(nested(run.id, "trial_events").where("event_type", "==", "trial_complete").limit(500));
  return { ...sanitizeRun(run, grant.study_type), lastSequence: Number(events[0]?.sequence ?? -1), completedTrialIds: [...new Set(completed.map((e) => e.trial_id).filter(Boolean))] };
});

app.post("/api/runs/:runId/start", async (request, reply) => {
  const grant = await requireGrant(request, reply); if (!grant) return;
  const id = z.string().uuid().safeParse((request.params as any).runId); if (!id.success) return reply.code(400).send({ error: "Ungültiger Durchlauf." });
  const ref = runRef(id.data); const result = await db.runTransaction(async (tx) => { const snap = await tx.get(ref); if (!snap.exists || snap.get("access_grant_id") !== grant.id || !["created", "running"].includes(snap.get("status"))) return null; const started = snap.get("started_at") ?? nowIso(); tx.update(ref, { status: "running", started_at: started }); return { id: id.data, status: "running", started_at: started }; });
  if (!result) return reply.code(409).send({ error: "Durchlauf kann nicht gestartet werden." }); return result;
});

app.post("/api/runs/:runId/events", async (request, reply) => {
  const grant = await requireGrant(request, reply); if (!grant) return;
  const params = z.object({ runId: z.string().uuid() }).safeParse(request.params); const body = z.object({ events: z.array(eventSchema).min(1).max(100) }).safeParse(request.body);
  if (!params.success || !body.success) return reply.code(400).send({ error: "Ungültige Ereignisdaten." });
  const rRef = runRef(params.data.runId); const events = body.data.events;
  let acceptedThrough: number | "missing" | "completed";
  try { acceptedThrough = await db.runTransaction(async (tx) => {
    const runSnap = await tx.get(rRef); if (!runSnap.exists || runSnap.get("access_grant_id") !== grant.id) return "missing";
    if (runSnap.get("status") === "completed") return "completed";
    const refs = events.flatMap((e) => [eventRef(params.data.runId, e.eventId), sequenceRef(params.data.runId, e.sequence)]);
    const snapshots = await tx.getAll(...refs); const seen = new Map<string, number>(); const seenIds = new Set<string>(); const seenSequences = new Set<number>();
    for (let i = 0; i < events.length; i++) {
      const event = events[i]; const eventSnap = snapshots[i * 2]; const seqSnap = snapshots[i * 2 + 1];
      if (eventSnap.exists || seqSnap.exists) {
        if (!eventSnap.exists || !seqSnap.exists || eventSnap.get("sequence") !== event.sequence || seqSnap.get("event_id") !== event.eventId) throw new Error("event-conflict");
      } else {
        if (seenIds.has(event.eventId) || seenSequences.has(event.sequence)) throw new Error("event-conflict");
        seenIds.add(event.eventId); seenSequences.add(event.sequence); seen.set(event.eventId, event.sequence);
      }
    }
    for (const event of events) {
      const existing = snapshots[events.indexOf(event) * 2]; if (existing.exists) continue;
      const stored = { sequence: event.sequence, event_id: event.eventId, event_type: event.eventType, trial_id: event.trialId ?? null, client_time_ms: event.clientTimeMs, server_time: nowIso(), payload: event.payload };
      tx.create(eventRef(params.data.runId, event.eventId), stored); tx.create(sequenceRef(params.data.runId, event.sequence), { event_id: event.eventId });
    }
    return Math.max(...events.map((e) => e.sequence));
  }); } catch (error) {
    if (error instanceof Error && error.message === "event-conflict") return reply.code(409).send({ error: "Event ID or sequence conflicts with an already stored event." });
    throw error;
  }
  if (acceptedThrough === "missing") return reply.code(404).send({ error: "Durchlauf nicht gefunden." });
  if (acceptedThrough === "completed") return reply.code(409).send({ error: "Der abgeschlossene Datensatz ist unveränderlich." });
  const max = await list(nested(params.data.runId, "trial_events").orderBy("sequence", "desc").limit(1));
  return { acceptedThrough: Number(max[0]?.sequence ?? acceptedThrough) };
});

app.post("/api/runs/:runId/outcome", async (request, reply) => {
  const grant = await requireGrant(request, reply); if (!grant) return;
  const params = z.object({ runId: z.string().uuid() }).safeParse(request.params);
  const body = z.object({ trialId: z.string(), profile: z.enum(["low", "neutral", "high"]), investment: z.number().min(0).max(1), chosenSide: z.enum(["left", "right"]).optional() }).safeParse(request.body);
  if (!params.success || !body.success) return reply.code(400).send({ error: "Ungültige Auszahlungsanfrage." });
  const rRef = runRef(params.data.runId); const run = row(await rRef.get());
  if (!run || run.access_grant_id !== grant.id) return reply.code(404).send({ error: "Durchlauf nicht gefunden." });
  if (run.status === "completed") return reply.code(409).send({ error: "Der abgeschlossene Datensatz ist unveränderlich." });
  const spec = run.schedule.trustTrials?.find((t: any) => t.trialId === body.data.trialId);
  if (!spec || (spec.condition !== "learning" && body.data.profile !== "neutral" && !spec.offeredProfiles.includes(body.data.profile))) return reply.code(409).send({ error: "Antwort passt nicht zum Versuchsplan." });
  const ref = outcomeRef(run.id, body.data.trialId); const prior = row(await ref.get());
  if (prior) { if (prior.investment !== body.data.investment || prior.profile !== body.data.profile || prior.chosen_side !== (body.data.chosenSide ?? null)) return reply.code(409).send({ error: "Diese Entscheidung wurde bereits bestätigt." }); return prior.result; }
  const condition = spec.condition === "punishment" ? "punishment" : spec.condition === "learning" ? "learning" : "reward";
  let result: Row; const investment = Math.round(body.data.investment * 100) / 100;
  if (condition === "learning") {
    const correct = body.data.chosenSide === spec.correctSide;
    result = { policyId: "learning-deterministic", invested: investment, tripled: investment * 3, returned: correct ? investment * 2 : 0, payoff: 1 - investment + (correct ? investment * 2 : 0), net: correct ? investment : -investment, outcomeType: correct ? "win" : "lose", condition, probability: correct ? 1 : 0, randomDraw: null };
  } else {
    const probabilities: Record<string, number> = condition === "reward" ? { high: 0.75, neutral: 0.5, low: 0.25 } : { high: 0.25, neutral: 0.5, low: 0.75 };
    const draw = Number.parseInt(stableJsonHash(`${run.seed}:${body.data.trialId}`).slice(0, 8), 16) / 0xffffffff; const favorable = draw < probabilities[body.data.profile];
    const outcomeType = condition === "reward" ? favorable ? "win" : "break_even" : favorable ? "break_even" : "lose"; const returned = outcomeType === "win" ? investment * 2 : outcomeType === "break_even" ? investment : 0;
    result = { policyId: `mri-probability-${spec.condition}-${body.data.profile}`, invested: investment, tripled: investment * 3, returned, payoff: 1 - investment + returned, net: (outcomeType === "win" ? 1 : outcomeType === "lose" ? -1 : 0) * investment, outcomeType, condition, probability: probabilities[body.data.profile], randomDraw: draw };
  }
  const saved = await db.runTransaction(async (tx) => { const [r, o] = await Promise.all([tx.get(rRef), tx.get(ref)]); if (!r.exists || r.get("access_grant_id") !== grant.id || r.get("status") === "completed") return { error: "run" as const }; if (o.exists) return { existing: o.data()! }; tx.create(ref, { trial_id: body.data.trialId, profile: body.data.profile, investment, chosen_side: body.data.chosenSide ?? null, result, created_at: nowIso() }); return { result }; });
  if ("error" in saved) return reply.code(409).send({ error: "Der abgeschlossene Datensatz ist unveränderlich." });
  if (saved.existing) { const old = saved.existing; if (old.investment !== investment || old.profile !== body.data.profile || old.chosen_side !== (body.data.chosenSide ?? null)) return reply.code(409).send({ error: "Diese Entscheidung wurde bereits bestätigt." }); return old.result; }
  return result;
});

app.post("/api/runs/:runId/risk-outcome", async (request, reply) => {
  const grant = await requireGrant(request, reply); if (!grant) return;
  const params = z.object({ runId: z.string().uuid() }).safeParse(request.params); const body = z.object({ trialId: z.string(), choice: z.enum(["sure", "gamble"]) }).safeParse(request.body);
  if (!params.success || !body.success) return reply.code(400).send({ error: "Ungültige Risikoentscheidung." });
  const rRef = runRef(params.data.runId); const run = row(await rRef.get());
  if (!run || run.access_grant_id !== grant.id) return reply.code(404).send({ error: "Durchlauf nicht gefunden." });
  if (run.status === "completed") return reply.code(409).send({ error: "Der abgeschlossene Datensatz ist unveränderlich." });
  const spec = run.schedule.riskTrials?.find((t: any) => t.trialId === body.data.trialId);
  if (!spec) return reply.code(409).send({ error: "Risikoentscheidung passt nicht zum Versuchsplan." });
  const ref = riskRef(run.id, body.data.trialId); const prior = row(await ref.get());
  if (prior) { if (prior.choice !== body.data.choice) return reply.code(409).send({ error: "Diese Entscheidung wurde bereits bestätigt." }); return prior.result; }
  const uniform = Number.parseInt(stableJsonHash(`${run.seed}:${body.data.trialId}`).slice(0, 8), 16) / 0xffffffff;
  const result = { choice: body.data.choice, realizedTokens: body.data.choice === "sure" ? spec.sureTokens : uniform < spec.gainProbability ? spec.gainTokens : spec.lossTokens, randomDraw: uniform };
  const saved = await db.runTransaction(async (tx) => { const [r, old] = await Promise.all([tx.get(rRef), tx.get(ref)]); if (!r.exists || r.get("access_grant_id") !== grant.id || r.get("status") === "completed") return "invalid"; if (old.exists) return old.get("choice") === body.data.choice ? old.get("result") : "conflict"; tx.create(ref, { trial_id: body.data.trialId, choice: body.data.choice, result, created_at: nowIso() }); return result; });
  if (saved === "invalid") return reply.code(409).send({ error: "Der abgeschlossene Datensatz ist unveränderlich." }); if (saved === "conflict") return reply.code(409).send({ error: "Diese Entscheidung wurde bereits bestätigt." }); return saved;
});

app.post("/api/runs/:runId/trustee-policy", async (request, reply) => {
  const grant = await requireGrant(request, reply); if (!grant || grant.study_type !== "trustee") return reply.code(403).send({ error: "Nicht für diesen Studientyp verfügbar." });
  const params = z.object({ runId: z.string().uuid() }).safeParse(request.params); const body = z.object({ returnsByInvestment: z.array(z.number().int().nonnegative()).length(11) }).safeParse(request.body);
  if (!params.success || !body.success || body.data.returnsByInvestment.some((v, i) => v > i * 3)) return reply.code(400).send({ error: "Ungültige Rückgabeentscheidungen." });
  const rRef = runRef(params.data.runId); const policyRef = rRef.collection("trustee_policy").doc("current");
  const saved = await db.runTransaction(async (tx) => {
    const snap = await tx.get(rRef);
    if (!snap.exists || snap.get("access_grant_id") !== grant.id) return "missing";
    if (snap.get("status") === "completed") return "completed";
    tx.set(policyRef, { returns_by_investment: body.data.returnsByInvestment, quality_passed: false, updated_at: nowIso() });
    return "saved";
  });
  if (saved === "missing") return reply.code(404).send({ error: "Durchlauf nicht gefunden." });
  if (saved === "completed") return reply.code(409).send({ error: "Der abgeschlossene Datensatz ist unveränderlich." });
  return { ok: true };
});

app.post("/api/runs/:runId/workflow-step", async (request, reply) => {
  const grant = await requireGrant(request, reply); if (!grant) return;
  const params = z.object({ runId: z.string().uuid() }).safeParse(request.params); const body = z.object({ stepId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), action: z.enum(["started", "completed", "failed"]), response: z.record(z.string(), z.unknown()).optional() }).safeParse(request.body);
  if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid workflow step event." });
  if (!grant.workflow_version_id) return reply.code(409).send({ error: "No workflow is assigned to this run." });
  const run = row(await runRef(params.data.runId).get()); if (!run || run.access_grant_id !== grant.id) return reply.code(404).send({ error: "Run not found." });
  if (run.status === "completed") return reply.code(409).send({ error: "The completed record is immutable." });
  if (run.status !== "running") return reply.code(409).send({ error: "Start the study before advancing workflow steps." });
  const definition = row(await db.collection(C.workflows).doc(grant.workflow_version_id).get()); const steps = (grant.workflow_steps ?? definition?.steps ?? []) as WorkflowStep[];
  const step = steps.find((s) => s.id === body.data.stepId); const stateRef = workflowStateRef(run.id, body.data.stepId); const state = row(await stateRef.get());
  if (!step || !state) return reply.code(404).send({ error: "Workflow step not found." });
  const position = steps.findIndex((s) => s.id === step.id); const priorRequired = steps.slice(0, position).filter((s) => s.required);
  if (priorRequired.length) {
    const priorStates = await Promise.all(priorRequired.map(async (s) => row(await workflowStateRef(run.id, s.id).get())));
    if (priorStates.some((s) => s?.status !== "completed")) return reply.code(409).send({ error: "Complete the earlier required workflow steps first." });
  }
  if (["in_progress", "completed"].includes(state.status) && body.data.action === "started") return { ok: true, status: state.status };
  if (state.status === "failed" && body.data.action === "failed") return { ok: true, status: "failed" };
  if (body.data.action === "completed") {
    if (state.status === "completed") return { ok: true, status: "completed" };
    if (step.moduleId === "trust-game") {
      const [outcomes, events] = await Promise.all([list(nested(run.id, "outcomes").limit(100)), list(nested(run.id, "trial_events").where("event_type", "==", "trial_complete").limit(500))]);
      const expected = new Set((run.schedule?.trustTrials ?? []).map((trial: any) => trial.trialId));
      const completed = new Set(events.filter((e) => e.payload?.domain === "trust").map((e) => e.trial_id));
      const resolved = new Set(outcomes.map((outcome) => outcome.trial_id));
      if (expected.size !== 72 || [...expected].some((id) => !completed.has(id) || !resolved.has(id))) return reply.code(409).send({ error: "The Trust Game step is not complete on the server." });
    } else if (step.moduleId.startsWith("questionnaire:")) {
      if (!body.data.response || JSON.stringify(body.data.response).length > 100_000) return reply.code(400).send({ error: "Questionnaire responses are missing or too large." });
      const instrument = questionnaireById(step.moduleId); if (!instrument || body.data.response.instrumentVersion !== instrument.version) return reply.code(409).send({ error: "Questionnaire version does not match the published instrument." });
      const checked = validateQuestionnaireResponses(step.moduleId, body.data.response.responses); if (!checked.ok) return reply.code(400).send({ error: checked.error });
    }
  }
  const status = body.data.action === "completed" ? "completed" : body.data.action === "started" ? "in_progress" : "failed"; const at = nowIso();
  await stateRef.update({ status, started_at: state.started_at ?? at, ...(status === "completed" ? { completed_at: at, response: body.data.response ?? state.response ?? null } : {}) });
  await addParticipantEvent(grant.id, `workflow_step_${body.data.action}`, { runId: run.id, stepId: step.id, moduleId: step.moduleId });
  return { ok: true, status };
});

app.post("/api/runs/:runId/complete", async (request, reply) => {
  const grant = await requireGrant(request, reply); if (!grant) return;
  const params = z.object({ runId: z.string().uuid() }).safeParse(request.params); const body = z.object({ summary: z.record(z.string(), z.unknown()) }).safeParse(request.body);
  if (!params.success || !body.success) return reply.code(400).send({ error: "Ungültiger Abschluss." });
  const rRef = runRef(params.data.runId); const run = row(await rRef.get()); if (!run || run.access_grant_id !== grant.id) return reply.code(404).send({ error: "Durchlauf nicht gefunden." });
  const mapping = grant.recruitment_source === "prolific" ? row(await db.collection(C.prolific).doc(grant.prolific_study_id).get()) : null;
  if (run.status === "completed") return { completionCode: run.completion?.completion_code ?? "", bonusEur: Number(run.bonus?.amount_eur ?? 0), completionRedirectUrl: mapping?.completion_url ?? null };
  if (run.status !== "running") return reply.code(409).send({ error: "Start the study before completing it." });
  const steps = grant.workflow_version_id ? ((grant.workflow_steps ?? row(await db.collection(C.workflows).doc(grant.workflow_version_id).get())?.steps ?? []) as WorkflowStep[]) : [];
  const hasTrustTask = grant.study_type === "investor" || steps.some((s) => s.moduleId === "trust-game");
  if (grant.recruitment_source === "prolific" && grant.workflow_version_id) {
    const states = await list(nested(run.id, "workflow_steps").limit(100)); const byId = new Map(states.map((s) => [s.step_id, s]));
    const missing = steps.filter((s) => s.required && byId.get(s.id)?.status !== "completed");
    if (missing.length) return reply.code(409).send({ error: "Der Durchlauf ist noch nicht vollständig.", incompleteSteps: missing.map((s) => s.id) });
  }
  let qualityStatus: "pass" | "review" = "review"; let serverQuality: Row = {}; let bonusEur = 0; let selectedTrialIds: string[] = [];
  if (hasTrustTask) {
    const [outcomes, events] = await Promise.all([list(nested(run.id, "outcomes").limit(100)), list(nested(run.id, "trial_events").orderBy("sequence").limit(2000))]);
    const expectedTrustTrials = new Set((run.schedule?.trustTrials ?? []).map((trial: any) => trial.trialId));
    const complete = events.filter((e) => e.event_type === "trial_complete");
    const completedTrustTrials = new Set(complete.filter((e) => e.payload?.domain === "trust").map((e) => e.trial_id));
    const resolvedTrustTrials = new Set(outcomes.map((outcome) => outcome.trial_id));
    if (expectedTrustTrials.size !== 72 || [...expectedTrustTrials].some((id) => !completedTrustTrials.has(id) || !resolvedTrustTrials.has(id))) return reply.code(409).send({ error: "Die Versuchsdaten wurden noch nicht vollständig übertragen." });
    const omissions = complete.filter((e) => e.payload?.omitted === true || e.payload?.omitted === "true").length;
    const comprehension = events.some((e) => e.event_type === "comprehension_attempt" && (e.payload?.correct === true || e.payload?.correct === "true"));
    const seriousness = events.filter((e) => e.event_type === "seriousness_check").at(-1)?.payload?.serious;
    const serious = seriousness === true || seriousness === "true";
    serverQuality = { omissions, browser_interactions: events.filter((e) => e.event_type === "browser_interaction").length, comprehension_passed: comprehension, seriousnessConfirmed: serious };
    qualityStatus = omissions === 0 && comprehension && serious ? "pass" : "review";
    const selected = outcomes.slice().sort((a, b) => stableJsonHash(`${run.seed}:${a.trial_id}`).localeCompare(stableJsonHash(`${run.seed}:${b.trial_id}`))).slice(0, 10);
    selectedTrialIds = selected.map((o) => o.trial_id); bonusEur = Math.round((selected.reduce((sum, o) => sum + Number(o.result.payoff), 0) / 30) * 500) / 100;
  } else if (grant.study_type === "trustee") {
    const policy = row(await nested(run.id, "trustee_policy").doc("current").get()); if (!policy) return reply.code(409).send({ error: "Die Entscheidungen wurden noch nicht gespeichert." });
    const events = await list(nested(run.id, "trial_events").limit(2000)); const decisions = new Set(events.filter((e) => e.event_type === "trustee_decision").map((e) => e.trial_id));
    const comprehension = events.some((e) => e.event_type === "comprehension_attempt" && (e.payload?.correct === true || e.payload?.correct === "true"));
    if (decisions.size < 11 || !comprehension) return reply.code(409).send({ error: "Die Versuchsdaten wurden noch nicht vollständig übertragen." });
    const selected = 1 + (Number.parseInt(stableJsonHash(`${run.seed}:trustee-bonus`).slice(0, 8), 16) % 10); const returned = Number(policy.returns_by_investment[selected]); bonusEur = Math.round(((selected * 3 - returned) / 30) * 500) / 100; selectedTrialIds = [`trustee-${selected}`]; qualityStatus = "pass";
  } else { qualityStatus = "pass"; serverQuality = { workflowOnly: true }; }
  const completion = { completion_code: newCode(), quality_status: qualityStatus, summary: { ...body.data.summary, serverQuality }, completed_at: nowIso() };
  const bonus = { selected_trial_ids: selectedTrialIds, amount_eur: bonusEur, calculation_version: hasTrustTask ? "trust-10-of-72-v2" : "trustee-one-of-10-v1", created_at: nowIso() };
  const saved = await db.runTransaction(async (tx) => {
    const [freshRun, freshGrant] = await Promise.all([tx.get(rRef), tx.get(grantRef(grant.id))]);
    if (!freshRun.exists || !freshGrant.exists || freshRun.get("access_grant_id") !== grant.id) return { error: "missing" as const };
    if (freshRun.get("status") === "completed") return { existing: freshRun.data()! };
    if (freshRun.get("status") !== "running") return { error: "state" as const };
    tx.update(rRef, { status: "completed", completed_at: nowIso(), completion, bonus }); tx.update(grantRef(grant.id), { status: "completed", completed_at: nowIso() });
    return { completion, bonus };
  });
  if ("error" in saved) return reply.code(saved.error === "missing" ? 404 : 409).send({ error: saved.error === "missing" ? "Durchlauf nicht gefunden." : "Start the study before completing it." });
  const savedRun = saved.existing ?? { completion: saved.completion, bonus: saved.bonus };
  const finalCompletion = savedRun.completion as Row; const finalBonus = savedRun.bonus as Row;
  return { completionCode: finalCompletion?.completion_code ?? "", bonusEur: Number(finalBonus?.amount_eur ?? 0), completionRedirectUrl: mapping?.completion_url ?? null };
});

app.post("/api/admin/codes", async (request, reply) => {
  const actor = await requireAdmin(request, reply); if (!actor) return;
  const body = z.object({ count: z.number().int().min(1).max(500), studyType: z.enum(["investor", "trustee"]), sex: z.enum(["male", "female"]).optional(), counterbalanceGroup: z.enum(["CB1", "CB2", "CB3"]).optional(), validDays: z.number().int().min(1).max(365).default(30) }).safeParse(request.body);
  if (!body.success) return reply.code(400).send({ error: "Invalid code request" });
  const startRef = db.collection(C.allocators).doc("manual-investor");
  const firstParticipantNumber = await db.runTransaction(async (tx) => { const snap = await tx.get(startRef); const current = Number(snap.get("next_participant_number") ?? 1); tx.set(startRef, { next_participant_number: current + (body.data.studyType === "investor" ? body.data.count : 0), updated_at: nowIso() }, { merge: true }); return current; });
  const grants: Row[] = []; const codes: string[] = [];
  for (let i = 0; i < body.data.count; i++) {
    const sex = body.data.sex ?? (i % 2 === 0 ? "male" : "female"); const participantNumber = firstParticipantNumber + i;
    const automatic = participantNumber % 3 === 0 ? "CB3" : participantNumber % 2 === 0 ? "CB2" : "CB1";
    const group = body.data.counterbalanceGroup ?? automatic; const code = body.data.studyType === "investor" ? newParticipantCode(sex, group) : newCode();
    const id = crypto.randomUUID(); const codeHash = digest(normalizeCode(code)); const at = nowIso();
    grants.push({ id, code, codeHash, data: { study_type: body.data.studyType, participant_sex: body.data.studyType === "investor" ? sex : null, counterbalance_group: body.data.studyType === "investor" ? group : null, status: "issued", protocol_version: PROTOCOL_VERSION, expires_at: expiresAt(body.data.validDays), created_at: at, recruitment_source: "manual" } }); codes.push(code);
  }
  // Commit at most 200 grant/index pairs per Firestore batch (400 writes), below
  // the per-commit write cap. Plaintext codes are only returned in this response.
  for (let offset = 0; offset < grants.length; offset += 200) {
    const batch = db.batch();
    for (const grant of grants.slice(offset, offset + 200)) { batch.create(grantRef(grant.id), grant.data); batch.create(db.collection(C.codeIndex).doc(grant.codeHash), { grant_id: grant.id }); }
    await batch.commit();
  }
  await audit(actor, "codes.generate", { count: codes.length, studyType: body.data.studyType }); return { codes };
});

app.get("/api/admin/workflow-modules", async (request, reply) => { const actor = await requireAdmin(request, reply); if (!actor) return; return { modules: WORKFLOW_MODULES }; });

app.get("/api/admin/workflows", async (request, reply) => {
  const actor = await requireAdmin(request, reply); if (!actor) return;
  const workflows = await list(db.collection(C.workflows).limit(1000));
  const mappings = await list(db.collection(C.prolific).limit(1000)); const byWorkflow = new Map(mappings.map((m) => [m.workflow_definition_id, m]));
  return { workflows: workflows.sort((a, b) => String(a.name).localeCompare(String(b.name)) || Number(b.version) - Number(a.version)).map((w) => { const p = byWorkflow.get(w.id); return { ...w, prolific_study_id: p?.id ?? null, prolific_active: p?.active ?? null, completion_url: p?.completion_url ?? null }; }) };
});

app.post("/api/admin/workflows", async (request, reply) => {
  const actor = await requireAdmin(request, reply); if (!actor) return;
  const parsed = z.object({ name: z.string().trim().min(3).max(100).regex(/^[\p{L}\p{N} ._-]+$/u), steps: z.unknown(), randomizeTaskOrder: z.boolean().default(false) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid workflow name or steps." });
  const valid = validateWorkflowSteps(parsed.data.steps); if (!valid.ok) return reply.code(400).send({ error: valid.error });
  const metaRef = db.collection("workflow_versions").doc(safeDocId(parsed.data.name)); const id = crypto.randomUUID(); const at = nowIso();
  const definitionContent = { steps: valid.steps, randomizeTaskOrder: parsed.data.randomizeTaskOrder };
  const version = await db.runTransaction(async (tx) => { const meta = await tx.get(metaRef); const next = Number(meta.get("latest") ?? 0) + 1; tx.set(metaRef, { name: parsed.data.name, latest: next }); tx.create(db.collection(C.workflows).doc(id), { name: parsed.data.name, version: next, status: "draft", steps: valid.steps, randomize_task_order: parsed.data.randomizeTaskOrder, content_hash: stableJsonHash(definitionContent), created_by: actor, created_at: at, published_at: null }); return next; });
  const workflow = row(await db.collection(C.workflows).doc(id).get()); await audit(actor, "workflow.draft.create", { id, name: parsed.data.name }); return { workflow: { ...workflow, version } };
});

app.post("/api/admin/workflows/:id/publish", async (request, reply) => {
  const actor = await requireAdmin(request, reply); if (!actor) return;
  const id = z.string().uuid().safeParse((request.params as any).id); if (!id.success) return reply.code(400).send({ error: "Invalid workflow ID." });
  const ref = db.collection(C.workflows).doc(id.data); const workflow = row(await ref.get()); if (!workflow) return reply.code(404).send({ error: "Workflow not found." });
  const valid = validateWorkflowSteps(workflow.steps); if (!valid.ok) return reply.code(409).send({ error: valid.error }); if (workflow.status !== "draft") return reply.code(409).send({ error: "Published workflow versions are immutable." });
  await db.runTransaction(async (tx) => { const fresh = await tx.get(ref); if (!fresh.exists || fresh.get("status") !== "draft") throw new Error("workflow-not-draft"); tx.update(ref, { status: "published", published_at: nowIso() }); });
  await audit(actor, "workflow.publish", { id: id.data, contentHash: workflow.content_hash }); return { workflow: { ...workflow, status: "published", published_at: nowIso() } };
});

app.post("/api/admin/prolific-studies", async (request, reply) => {
  const actor = await requireAdmin(request, reply); if (!actor) return;
  const body = z.object({ prolificStudyId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), workflowDefinitionId: z.string().uuid(), completionUrl: completionUrlSchema(), active: z.boolean().default(false) }).safeParse(request.body);
  if (!body.success) return reply.code(400).send({ error: "Invalid Prolific study mapping." });
  if (isProduction && body.data.active && process.env.CONSENT_RELEASED !== "true") return reply.code(409).send({ error: "Production consent has not been released; this Prolific study cannot be activated." });
  const def = row(await db.collection(C.workflows).doc(body.data.workflowDefinitionId).get()); if (!def || def.status !== "published") return reply.code(409).send({ error: "Only a published workflow can be mapped to Prolific." });
  const ref = db.collection(C.prolific).doc(body.data.prolificStudyId); const data = { workflow_definition_id: def.id, completion_url: body.data.completionUrl, active: body.data.active, created_by: actor, updated_at: nowIso() };
  await ref.set(data, { merge: true }); await audit(actor, "prolific-study.configure", { studyId: body.data.prolificStudyId, workflowDefinitionId: def.id, active: body.data.active }); return { study: { id: body.data.prolificStudyId, ...data } };
});

app.get("/api/admin/summary", async (request, reply) => {
  const actor = await requireAdmin(request, reply); if (!actor) return;
  const [grants, banks, runs] = await Promise.all([list(db.collection(C.grants).limit(10_000)), list(db.collection(C.banks).where("active", "==", true).limit(1)), list(db.collection(C.runs).where("study_type", "==", "trustee").limit(5000))]);
  const counts = new Map<string, number>(); for (const g of grants) { const key = `${g.study_type}:${g.status}`; counts.set(key, (counts.get(key) ?? 0) + 1); }
  const policyRows = await Promise.all(runs.map((r) => nested(r.id, "trustee_policy").doc("current").get())); const policyCount = policyRows.filter((p) => p.exists).length; const policyPass = policyRows.filter((p) => p.exists && p.get("quality_passed") === true).length;
  return { protocolVersion: PROTOCOL_VERSION, grants: [...counts].map(([key, count]) => { const [study_type, status] = key.split(":"); return { study_type, status, count }; }), activeBank: banks[0] ? { version: banks[0].version, source: banks[0].source, content_hash: banks[0].content_hash, created_at: banks[0].created_at } : null, trusteePolicies: { count: policyCount, passed: policyPass } };
});

app.get("/api/admin/codes", async (request, reply) => {
  const actor = await requireAdmin(request, reply); if (!actor) return;
  const grants = (await list(db.collection(C.grants).orderBy("created_at", "desc").limit(500)));
  const output = await Promise.all(grants.map(async (g) => {
    const run = (await list(db.collection(C.runs).where("access_grant_id", "==", g.id).limit(1)))[0];
    let progress: Row[] = [];
    if (run?.workflow_definition_id) { const def = row(await db.collection(C.workflows).doc(run.workflow_definition_id).get()); if (def) { const states = await list(nested(run.id, "workflow_steps").limit(100)); const map = new Map(states.map((s) => [s.step_id, s])); progress = (def.steps as WorkflowStep[]).map((step) => { const s = map.get(step.id); return { stepId: step.id, moduleId: step.moduleId, status: s?.status ?? "not_started", startedAt: s?.started_at ?? null, completedAt: s?.completed_at ?? null }; }); } }
    return { id: g.id, study_type: g.study_type, participant_sex: g.participant_sex ?? null, counterbalance_group: g.counterbalance_group ?? null, status: g.status, expires_at: g.expires_at, created_at: g.created_at, completed_at: g.completed_at ?? null, recruitment_source: g.recruitment_source ?? "manual", prolific_pid: g.prolific_pid ?? null, prolific_study_id: g.prolific_study_id ?? null, prolific_session_id: g.prolific_session_id ?? null, gender_identity: g.gender_identity ?? null, face_set_preference: g.face_set_preference ?? null, run_id: run?.id ?? null, run_status: run?.status ?? null, started_at: run?.started_at ?? null, run_completed_at: run?.completed_at ?? null, workflow_progress: progress };
  }));
  return { grants: output };
});

app.post("/api/admin/codes/:id/revoke", async (request, reply) => {
  const actor = await requireAdmin(request, reply); if (!actor) return;
  const id = z.string().uuid().safeParse((request.params as any).id); if (!id.success) return reply.code(400).send({ error: "Invalid grant ID" });
  const ref = grantRef(id.data); const snap = await ref.get(); if (snap.exists && snap.get("status") !== "completed") await ref.update({ status: "revoked" });
  await audit(actor, "code.revoke", { id: id.data }); return { ok: true };
});

app.get("/api/admin/trustee-policies", async (request, reply) => {
  const actor = await requireAdmin(request, reply); if (!actor) return;
  const runs = await list(db.collection(C.runs).where("study_type", "==", "trustee").limit(5000));
  const policies = (await Promise.all(runs.map(async (r) => { const p = row(await nested(r.id, "trustee_policy").doc("current").get()); if (!p) return null; const events = await list(nested(r.id, "trial_events").where("event_type", "==", "trustee_decision").limit(200)); const times = events.map((e) => Number(e.payload?.rt_ms)).filter(Number.isFinite); return { id: r.id, returns_by_investment: p.returns_by_investment, quality_passed: p.quality_passed, created_at: p.updated_at, quality_status: r.completion?.quality_status ?? null, completed_at: r.completed_at ?? null, decision_count: events.length, average_rt_ms: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null }; }))).filter(Boolean);
  return { policies };
});

app.post("/api/admin/trustee-policies/:id/quality", async (request, reply) => {
  const actor = await requireAdmin(request, reply); if (!actor) return;
  const id = z.string().uuid().safeParse((request.params as any).id); const body = z.object({ passed: z.boolean() }).safeParse(request.body);
  if (!id.success || !body.success) return reply.code(400).send({ error: "Invalid quality decision" });
  const ref = nested(id.data, "trustee_policy").doc("current"); const snap = await ref.get(); if (!snap.exists) return reply.code(404).send({ error: "Trustee policy not found" });
  await ref.update({ quality_passed: body.data.passed }); await audit(actor, "trustee-policy.quality", { id: id.data, passed: body.data.passed }); return { id: id.data, quality_passed: body.data.passed };
});

app.post("/api/admin/outcome-bank/build", async (request, reply) => {
  const actor = await requireAdmin(request, reply); if (!actor) return;
  const body = z.object({ version: z.string().regex(/^[a-zA-Z0-9._-]{3,80}$/) }).safeParse(request.body); if (!body.success) return reply.code(400).send({ error: "Invalid bank version" });
  const runs = await list(db.collection(C.runs).where("study_type", "==", "trustee").limit(5000)); const policies: TrusteePolicy[] = [];
  for (const r of runs) { const p = row(await nested(r.id, "trustee_policy").doc("current").get()); if (p) policies.push({ policyId: r.id, returnsByInvestment: p.returns_by_investment, qualityPassed: p.quality_passed }); }
  let bank: OutcomeBank; try { bank = buildRecordedBank(policies, body.data.version); } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  const bankRef = db.collection(C.banks).doc(bank.version); await db.runTransaction(async (tx) => { const current = await tx.get(db.collection(C.banks).where("active", "==", true)); for (const d of current.docs) tx.update(d.ref, { active: false }); tx.set(bankRef, { version: bank.version, source: bank.source, content_hash: stableJsonHash(bank), bank, active: true, created_at: nowIso() }); });
  await audit(actor, "outcome-bank.build", { version: bank.version, policies: policies.length }); return { version: bank.version, hash: stableJsonHash(bank) };
});

async function researchExport(grantId?: string) {
  const runQuery = grantId ? db.collection(C.runs).where("access_grant_id", "==", grantId) : db.collection(C.runs).orderBy("created_at");
  const rawRuns = await list(runQuery.limit(5000)); const grants = new Map<string, Row>();
  for (const run of rawRuns) { if (!grants.has(run.access_grant_id)) { const g = row(await grantRef(run.access_grant_id).get()); if (g) grants.set(g.id, g); } }
  const runs: Row[] = rawRuns.map((r) => { const g = grants.get(r.access_grant_id)!; return { run_id: r.id, protocol_version: r.protocol_version, schema_version: r.schema_version, schedule_hash: r.schedule_hash, outcome_bank_version: r.outcome_bank_version ?? null, host: r.host, host_session_id: r.host_session_id ?? null, deployment_id: r.deployment_id ?? null, client_version: r.client_version ?? null, status: r.status, started_at: r.started_at ?? null, completed_at: r.completed_at ?? null, study_type: g.study_type, participant_sex: g.participant_sex ?? null, counterbalance_group: g.counterbalance_group ?? null, workflow_definition_id: r.workflow_definition_id ?? null, workflow_steps: r.workflow_steps ?? null, workflow_order_randomized: r.workflow_order_randomized ?? false, workflow_order_algorithm: r.workflow_order_algorithm ?? null, recruitment_source: g.recruitment_source ?? "manual", prolific_pid: g.prolific_pid ?? null, prolific_study_id: g.prolific_study_id ?? null, prolific_session_id: g.prolific_session_id ?? null, gender_identity: g.gender_identity ?? null, face_set_preference: g.face_set_preference ?? null, completion_code: r.completion?.completion_code ?? null, quality_status: r.completion?.quality_status ?? null, summary: r.completion?.summary ?? null, bonus_eur: r.bonus?.amount_eur ?? null }; });
  const events: Row[] = []; const participantEvents: Row[] = []; const workflowSteps: Row[] = [];
  for (const r of rawRuns) {
    const [trial, pEvents, wSteps] = await Promise.all([list(nested(r.id, "trial_events").orderBy("sequence").limit(5000)), list(grantRef(r.access_grant_id).collection("participant_events").orderBy("server_time").limit(5000)), list(nested(r.id, "workflow_steps").orderBy(FieldPath.documentId()).limit(100))]);
    events.push(...trial.map((e) => ({ run_id: r.id, sequence: e.sequence, event_type: e.event_type, trial_id: e.trial_id ?? null, client_time_ms: e.client_time_ms, server_time: e.server_time, payload: e.payload })));
    participantEvents.push(...pEvents.map((e) => ({ access_grant_id: r.access_grant_id, event_type: e.event_type, client_time_ms: e.client_time_ms ?? null, server_time: e.server_time, payload: e.payload })));
    workflowSteps.push(...wSteps.map((s) => ({ run_id: r.id, step_id: s.step_id, module_id: s.module_id, required: s.required, status: s.status, started_at: s.started_at, completed_at: s.completed_at, response: s.response })));
  }
  const runMetadata = new Map(runs.map((r) => [r.run_id, r]));
  const trialRows = events.filter((e) => e.event_type === "trial_complete").map((event) => { const run = runMetadata.get(event.run_id); return { ...run, ...event, ...(event.payload as Row), run_id: event.run_id, sequence: event.sequence, trial_id: event.trial_id, client_time_ms: event.client_time_ms, server_time: event.server_time }; });
  const containsProlificLinkage = runs.some((r) => r.recruitment_source === "prolific");
  return { schemaVersion: DATA_SCHEMA_VERSION, exportedAt: nowIso(), directLinkageExcluded: !containsProlificLinkage, containsProlificLinkage, runs, events, participantEvents, workflowSteps, trialRows };
}

function trialRowsTsv(data: { trialRows?: Array<Record<string, unknown>> }) {
  const rows = data.trialRows ?? []; const columns = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const quote = (v: unknown) => { const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v); return `"${s.replaceAll('"', '""')}"`; };
  return [columns.join("\t"), ...rows.map((r) => columns.map((key) => quote(r[key])).join("\t"))].join("\n");
}

app.get("/api/admin/export", async (request, reply) => { const actor = await requireAdmin(request, reply); if (!actor) return; const data = await researchExport(); await audit(actor, "data.export", { scope: "all", runs: data.runs.length, events: data.events.length }); return data; });
app.get<{ Params: { grantId: string } }>("/api/admin/export/:grantId", async (request, reply) => { const actor = await requireAdmin(request, reply); if (!actor) return; const id = z.string().uuid().safeParse(request.params.grantId); if (!id.success) return reply.code(400).send({ error: "Invalid grant ID" }); const data = await researchExport(id.data); await audit(actor, "data.export", { scope: "grant", grantId: id.data, runs: data.runs.length, events: data.events.length }); return data; });
app.get<{ Params: { grantId: string }; Querystring: { format?: string } }>("/api/admin/export/:grantId/file", async (request, reply) => {
  const actor = await requireAdmin(request, reply); if (!actor) return; const grantId = z.string().uuid().safeParse(request.params.grantId); const format = z.enum(["json", "tsv"]).safeParse(request.query.format);
  if (!grantId.success || !format.success) return reply.code(400).send({ error: "Invalid export request." });
  const run = (await list(db.collection(C.runs).where("access_grant_id", "==", grantId.data).limit(1)))[0]; if (!run) return reply.code(404).send({ error: "No run found for this participant." });
  const data = await researchExport(grantId.data); const contents = Buffer.from(format.data === "json" ? JSON.stringify(data, null, 2) : trialRowsTsv(data));
  await audit(actor, "data.export.file", { scope: "grant", grantId: grantId.data, format: format.data, source: "firestore-generated" });
  reply.header("Cache-Control", "no-store"); reply.header("Content-Type", format.data === "json" ? "application/json; charset=utf-8" : "text/tab-separated-values; charset=utf-8"); reply.header("Content-Disposition", `attachment; filename=participant-${run.id}.${format.data}`); return reply.send(contents);
});

if (isProduction && process.env.FIREBASE_FUNCTIONS_MODE !== "true") {
  await app.register(fastifyStatic, { root: path.resolve(process.env.STATIC_ROOT ?? path.join(process.cwd(), "dist")), prefix: "/" });
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}

app.addHook("onClose", async () => {
  const firebaseApp = getApps()[0]; if (firebaseApp) await deleteApp(firebaseApp);
});
const port = Number(process.env.PORT ?? 3001); const host = process.env.HOST ?? "127.0.0.1";
export { app };
if (process.env.FIREBASE_FUNCTIONS_MODE !== "true") await app.listen({ port, host });
