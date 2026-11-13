import "dotenv/config";
import path from "node:path";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import {
  DATA_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  buildRecordedBank,
  createTrustSchedule,
  validateSchedule,
  nextLeastUsedCounterbalanceGroup,
  makeDevelopmentBank,
  resolveOutcome,
  type OutcomeBank,
  type PartnerProfile,
  type TrusteePolicy,
} from "../src/shared/protocol.js";
import { createDatabase, migrate } from "./db.js";
import { uploadResearchArchive, downloadResearchArchive, trialRowsTsv, verifyResearcherIdToken } from "./firebaseArchive.js";
import { validateWorkflowSteps, WORKFLOW_MODULES, type WorkflowStep } from "../src/shared/workflow.js";
import { questionnaireById, validateQuestionnaireResponses } from "../src/shared/questionnaires.js";
import {
  adminIdentity,
  checkRateLimit,
  digest,
  newCode,
  newParticipantCode,
  newToken,
  normalizeCode,
  stableJsonHash,
} from "./security.js";

const SESSION_COOKIE = "research_session";
const isProduction = process.env.NODE_ENV === "production";
const hostedOrigins = new Set(
  (process.env.STUDY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const hostSchema = z.enum(["portal", "jatos", "pavlovia", "github-pages"]);
if (
  isProduction &&
  (!process.env.CODE_PEPPER || process.env.CODE_PEPPER.length < 32)
) {
  throw new Error(
    "Production requires CODE_PEPPER with at least 32 characters.",
  );
}
if (
  isProduction &&
  (!process.env.OIDC_PROXY_SECRET || process.env.OIDC_PROXY_SECRET.length < 32)
) {
  throw new Error(
    "Production requires OIDC_PROXY_SECRET with at least 32 characters.",
  );
}
if (isProduction && (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_STORAGE_BUCKET)) {
  throw new Error("Production requires a Firebase project and private Storage bucket for research archives.");
}
if (isProduction && !(process.env.RESEARCHER_ACCOUNT_EMAILS ?? "").split(",").some((email) => email.trim())) {
  throw new Error("Production requires at least one allow-listed researcher account with Firebase TOTP MFA.");
}

const app = Fastify({ logger: true, bodyLimit: 2_000_000, trustProxy: true });
const db = createDatabase();
await migrate(db);
await app.register(cookie);

app.addHook("onRequest", async (request, reply) => {
  const origin = request.headers.origin;
  if (!origin || !hostedOrigins.has(origin)) return;
  reply.header("Access-Control-Allow-Origin", origin);
  reply.header("Vary", "Origin");
  reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Study-Host, X-Study-Session-Id, X-Study-Deployment-Id, X-Study-Client-Version");
  reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (request.method === "OPTIONS") return reply.code(204).send();
});

app.addHook("onSend", async (request, reply, payload) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  reply.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (isProduction)
    reply.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  if (request.raw.url?.startsWith("/api/"))
    reply.header("Cache-Control", "no-store");
  return payload;
});

const eventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  eventId: z.string().uuid(),
  eventType: z.string().min(1).max(80),
  trialId: z.string().max(80).nullable().optional(),
  clientTimeMs: z.number().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
});

async function bootstrap() {
  await db.query(
    `INSERT INTO protocols(version, status, configuration)
     VALUES ($1, 'active', $2) ON CONFLICT (version) DO NOTHING`,
    [
      PROTOCOL_VERSION,
      {
        riskTrials: 0,
        trustTrials: 72,
        rewardTrials: 24,
        punishmentTrials: 24,
        learningTrials: 24,
      },
    ],
  );
  const active = await db.query(
    "SELECT version FROM outcome_banks WHERE active = true LIMIT 1",
  );
  if (!active.rowCount && !isProduction) {
    const bank = makeDevelopmentBank();
    await db.query(
      `INSERT INTO outcome_banks(version, source, content_hash, bank, active)
       VALUES ($1, $2, $3, $4, true) ON CONFLICT (version) DO NOTHING`,
      [bank.version, bank.source, stableJsonHash(bank), bank],
    );
  }
  if (!isProduction && process.env.DEV_ACCESS_CODE) {
    const code = normalizeCode(process.env.DEV_ACCESS_CODE);
    await db.query(
      `INSERT INTO access_grants(code_hash, study_type, protocol_version, expires_at)
       VALUES ($1, 'investor', $2, now() + interval '30 days') ON CONFLICT (code_hash) DO NOTHING`,
      [digest(code), PROTOCOL_VERSION],
    );
  }
}
await bootstrap();

async function grantFor(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;
  const token = request.cookies[SESSION_COOKIE] ?? bearer;
  if (!token) return null;
  const result = await db.query(
    `SELECT g.* FROM participant_sessions s
     JOIN access_grants g ON g.id = s.access_grant_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND g.expires_at > now() AND g.status <> 'revoked'`,
    [digest(token)],
  );
  if (!result.rowCount) return null;
  await db.query(
    "UPDATE participant_sessions SET last_seen_at = now() WHERE token_hash = $1",
    [digest(token)],
  );
  return result.rows[0] as Record<string, unknown>;
}

async function requireGrant(request: FastifyRequest, reply: any) {
  const grant = await grantFor(request);
  if (!grant) {
    reply.code(401).send({
      error:
        "Sitzung abgelaufen. Bitte geben Sie Ihren Zugangscode erneut ein.",
    });
    return null;
  }
  return grant;
}

async function requireAdmin(request: FastifyRequest, reply: any) {
  const actor = adminIdentity(request);
  if (!actor) {
    const authorization = request.headers.authorization;
    const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    const verified = bearer ? await verifyResearcherIdToken(bearer) : null;
    if (verified) return verified;
    reply.code(401).send({ error: "Researcher authentication required" });
    return null;
  }
  return actor;
}

function completionUrlSchema() {
  return z.string().url().refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "app.prolific.com" &&
        url.pathname === "/submissions/complete" && /^[A-Z0-9]{6,16}$/.test(url.searchParams.get("cc") ?? "");
    } catch {
      return false;
    }
  }, "Use the HTTPS Prolific completion URL for this study.");
}

app.get("/api/health", async () => {
  await db.query("SELECT 1");
  return { ok: true, protocolVersion: PROTOCOL_VERSION };
});

app.post("/api/auth/code", async (request, reply) => {
  const remote = request.ip;
  const parsed = z
    .object({ code: z.string().min(8).max(80) })
    .safeParse(request.body);
  if (!parsed.success)
    return reply.code(400).send({ error: "Ungültiges Codeformat." });
  const normalized = normalizeCode(parsed.data.code);
  if (
    !checkRateLimit(`ip:${remote}`, 15, 15 * 60_000) ||
    !checkRateLimit(`code:${digest(normalized)}`, 8, 15 * 60_000)
  ) {
    return reply.code(429).send({
      error:
        "Zu viele Versuche. Bitte warten Sie und versuchen Sie es später erneut.",
    });
  }
  if (
    !isProduction &&
    process.env.DEV_ADMIN_TOKEN &&
    normalized === normalizeCode(process.env.DEV_ADMIN_TOKEN)
  ) {
    return { studyType: "admin" as const };
  }
  const result = await db.query(
    `SELECT * FROM access_grants WHERE code_hash = $1 AND expires_at > now() AND status NOT IN ('revoked', 'completed')`,
    [digest(normalized)],
  );
  if (!result.rowCount)
    return reply
      .code(401)
      .send({ error: "Der Zugangscode ist ungültig oder nicht mehr aktiv." });
  const grant = result.rows[0];
  const token = newToken();
  await db.query(
    `INSERT INTO participant_sessions(access_grant_id, token_hash, expires_at)
     VALUES ($1, $2, LEAST($3::timestamptz, now() + interval '12 hours'))`,
    [grant.id, digest(token), grant.expires_at],
  );
  await db.query(
    "UPDATE access_grants SET status = 'active' WHERE id = $1 AND status = 'issued'",
    [grant.id],
  );
  const requestedHost = request.headers["x-study-host"];
  const hosted = typeof requestedHost === "string" && hostSchema.safeParse(requestedHost).success && requestedHost !== "portal";
  if (!hosted) {
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: "strict",
      path: "/",
      maxAge: 12 * 60 * 60,
    });
  }
  return {
    studyType: grant.study_type,
    protocolVersion: grant.protocol_version,
    ...(hosted ? { sessionToken: token, host: requestedHost } : {}),
  };
});

app.post("/api/auth/logout", async (request, reply) => {
  const authorization = request.headers.authorization;
  const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;
  const token = request.cookies[SESSION_COOKIE] ?? bearer;
  if (token)
    await db.query("DELETE FROM participant_sessions WHERE token_hash = $1", [
      digest(token),
    ]);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
  return { ok: true };
});

app.post("/api/prolific/entry", async (request, reply) => {
  const body = z.object({
    prolificPid: z.string().regex(/^[A-Za-z0-9]{24}$/),
    studyId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  }).safeParse(request.body);
  if (!body.success)
    return reply.code(400).send({ error: "Required Prolific study parameters are missing or invalid." });
  if (!checkRateLimit(`prolific:${request.ip}`, 30, 60_000))
    return reply.code(429).send({ error: "Too many attempts. Please try again shortly." });

  const mapping = await db.query(
    `SELECT p.prolific_study_id, p.completion_url, w.*
     FROM prolific_studies p JOIN workflow_definitions w ON w.id = p.workflow_definition_id
     WHERE p.prolific_study_id = $1 AND p.active = true AND w.status = 'published'`,
    [body.data.studyId],
  );
  if (!mapping.rowCount)
    return reply.code(403).send({ error: "This Prolific study is not currently configured." });

  const definition = mapping.rows[0];
  const checkedSteps = validateWorkflowSteps(definition.steps);
  if (!checkedSteps.ok)
    return reply.code(503).send({ error: "The configured workflow is not available." });
  const existing = await db.query(
    `SELECT * FROM access_grants WHERE prolific_study_id = $1 AND prolific_session_id = $2`,
    [body.data.studyId, body.data.sessionId],
  );
  let grant = existing.rows[0];
  if (!grant) {
    const studyType = checkedSteps.steps.some((step) => step.moduleId === "trust-game") ? "investor" : "workflow";
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // Allocate one of the three MRI-defined counterbalancing schedules in
      // least-used-first order, serialized per Prolific study to avoid ties
      // becoming overrepresented under concurrent participant entry.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`prolific-cb:${body.data.studyId}`]);
      const counts = await client.query(
        `SELECT counterbalance_group, count(*)::int AS n FROM access_grants
         WHERE prolific_study_id = $1 AND recruitment_source = 'prolific'
         GROUP BY counterbalance_group`,
        [body.data.studyId],
      );
      const used = Object.fromEntries(counts.rows.map((row) => [row.counterbalance_group, Number(row.n)]));
      const counterbalanceGroup = nextLeastUsedCounterbalanceGroup(used);
      const inserted = await client.query(
        `INSERT INTO access_grants(code_hash, study_type, counterbalance_group, status, protocol_version, expires_at,
            recruitment_source, prolific_pid, prolific_study_id, prolific_session_id, workflow_version_id)
         VALUES ($1, $2, $3, 'issued', $4, now() + interval '7 days', 'prolific', $5, $6, $7, $8)
         ON CONFLICT (prolific_study_id, prolific_session_id)
           WHERE prolific_study_id IS NOT NULL AND prolific_session_id IS NOT NULL
         DO NOTHING RETURNING *`,
        [digest(newToken()), studyType, counterbalanceGroup, PROTOCOL_VERSION, body.data.prolificPid,
          body.data.studyId, body.data.sessionId, definition.id],
      );
      grant = inserted.rows[0] ?? (await client.query(
        `SELECT * FROM access_grants WHERE prolific_study_id = $1 AND prolific_session_id = $2`,
        [body.data.studyId, body.data.sessionId],
      )).rows[0];
      if (!grant) throw new Error("Could not initialize the Prolific session.");
      if (inserted.rowCount) await client.query(
        `INSERT INTO participant_events(access_grant_id, event_type, payload)
         VALUES ($1, 'prolific_entry', $2)`,
        [grant.id, { studyId: body.data.studyId, sessionId: body.data.sessionId, counterbalanceGroup }],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } else if (grant.prolific_pid !== body.data.prolificPid) {
    return reply.code(409).send({ error: "This Prolific session is already linked to a different participant record." });
  }

  const token = newToken();
  await db.query(
    `INSERT INTO participant_sessions(access_grant_id, token_hash, expires_at)
     VALUES ($1, $2, LEAST($3::timestamptz, now() + interval '12 hours'))`,
    [grant.id, digest(token), grant.expires_at],
  );
  await db.query(
    "UPDATE access_grants SET status = CASE WHEN status = 'issued' THEN 'active' ELSE status END WHERE id = $1",
    [grant.id],
  );
  await db.query(
    `INSERT INTO participant_events(access_grant_id, event_type, payload)
     VALUES ($1, 'prolific_entry_resumed', $2)`,
    [grant.id, { sessionId: body.data.sessionId }],
  );
  return {
    sessionToken: token,
    recruitmentSource: "prolific",
    status: grant.status,
    workflow: {
      id: definition.id,
      name: definition.name,
      version: definition.version,
      steps: checkedSteps.steps,
      contentHash: definition.content_hash,
    },
  };
});

app.get("/api/participant/status", async (request, reply) => {
  const grant = await requireGrant(request, reply);
  if (!grant) return;
  const consent = await db.query(
    "SELECT accepted, document_version FROM consents WHERE access_grant_id = $1 ORDER BY recorded_at DESC LIMIT 1",
    [grant.id],
  );
  const run = await db.query(
    `SELECT r.id, r.status, r.protocol_version, c.completion_code,
            b.amount_eur AS bonus_eur, r.workflow_definition_id
     FROM study_runs r
     LEFT JOIN completions c ON c.run_id = r.id
     LEFT JOIN bonuses b ON b.run_id = r.id
     WHERE r.access_grant_id = $1`,
    [grant.id],
  );
  const workflow = grant.workflow_version_id
    ? await db.query(
        `SELECT d.id, d.name, d.version, d.steps, d.content_hash,
                s.step_id, s.module_id, s.status AS step_status, s.started_at AS step_started_at,
                s.completed_at AS step_completed_at
         FROM workflow_definitions d LEFT JOIN workflow_step_states s ON s.run_id = $2
         WHERE d.id = $1 ORDER BY s.step_id`,
        [grant.workflow_version_id, run.rows[0]?.id ?? null],
      )
    : null;
  const workflowDefinition = workflow?.rows[0]
    ? {
        id: workflow.rows[0].id,
        name: workflow.rows[0].name,
        version: workflow.rows[0].version,
        steps: workflow.rows[0].steps,
        contentHash: workflow.rows[0].content_hash,
        progress: workflow.rows.filter((row) => row.step_id).map((row) => ({
          stepId: row.step_id,
          moduleId: row.module_id,
          status: row.step_status,
          startedAt: row.step_started_at,
          completedAt: row.step_completed_at,
        })),
      }
    : null;
  const prolificStudy = grant.recruitment_source === "prolific"
    ? await db.query("SELECT completion_url FROM prolific_studies WHERE prolific_study_id = $1", [grant.prolific_study_id])
    : null;
  return {
    studyType: grant.study_type,
    status: grant.status,
    recruitmentSource: grant.recruitment_source,
    hasFaceSetSelection: Boolean(grant.gender_identity),
    consented: consent.rows[0]?.accepted === true,
    consentVersion: consent.rows[0]?.document_version ?? null,
    run: run.rows[0] ?? null,
    workflow: workflowDefinition,
    completionRedirectUrl: prolificStudy?.rows[0]?.completion_url ?? null,
  };
});

app.post("/api/participant/consent", async (request, reply) => {
  const grant = await requireGrant(request, reply);
  if (!grant) return;
  const parsed = z
    .object({
      accepted: z.boolean(),
      // Keep v1 readable for already-issued local sessions, while the current
      // participant-facing document is versioned as consent-de-v2.
      documentVersion: z.union([
        z.literal("consent-de-v1"),
        z.literal("consent-de-v2"),
        z.literal("consent-prolific-de-v1"),
      ]),
    })
    .safeParse(request.body);
  if (!parsed.success)
    return reply.code(400).send({ error: "Ungültige Einwilligungsdaten." });
  await db.query(
    "INSERT INTO consents(access_grant_id, document_version, accepted) VALUES ($1, $2, $3)",
    [grant.id, parsed.data.documentVersion, parsed.data.accepted],
  );
  return { ok: true };
});

app.post("/api/participant/face-set", async (request, reply) => {
  const grant = await requireGrant(request, reply);
  if (!grant) return;
  if (grant.recruitment_source !== "prolific")
    return reply.code(403).send({ error: "This participant question is only available in the Prolific workflow." });
  const body = z.object({
    genderIdentity: z.enum(["man", "woman", "nonbinary", "self_described", "prefer_not_to_say"]),
    faceSetPreference: z.enum(["male", "female", "random"]).optional(),
  }).safeParse(request.body);
  if (!body.success)
    return reply.code(400).send({ error: "Please choose a response and face-set preference." });
  const needsPreference = !["man", "woman"].includes(body.data.genderIdentity);
  if (needsPreference && !body.data.faceSetPreference)
    return reply.code(400).send({ error: "A face-set preference is required for this response." });
  const faceSetPreference = body.data.faceSetPreference ??
    (body.data.genderIdentity === "man" ? "male" : "female");
  if (grant.gender_identity && (
    grant.gender_identity !== body.data.genderIdentity || grant.face_set_preference !== faceSetPreference
  )) return reply.code(409).send({ error: "This response has already been recorded for this session." });
  const updated = await db.query(
    `UPDATE access_grants SET gender_identity = $2, face_set_preference = $3
     WHERE id = $1 AND gender_identity IS NULL RETURNING id`,
    [grant.id, body.data.genderIdentity, faceSetPreference],
  );
  if (!updated.rowCount) {
    const saved = await db.query("SELECT gender_identity, face_set_preference FROM access_grants WHERE id = $1", [grant.id]);
    if (saved.rows[0]?.gender_identity !== body.data.genderIdentity || saved.rows[0]?.face_set_preference !== faceSetPreference)
      return reply.code(409).send({ error: "This response has already been recorded for this session." });
  } else await db.query(
    `INSERT INTO participant_events(access_grant_id, event_type, payload)
     VALUES ($1, 'face_set_selection', $2)`,
    [grant.id, { genderIdentity: body.data.genderIdentity, faceSetPreference }],
  );
  return { ok: true, faceSetPreference };
});

app.post("/api/runs", async (request, reply) => {
  const grant = await requireGrant(request, reply);
  if (!grant) return;
  if (isProduction && process.env.CONSENT_RELEASED !== "true") {
    return reply.code(503).send({
      error:
        "Die Studie ist noch nicht durch die Ethikfreigabe für die Datenerhebung aktiviert.",
    });
  }
  const consent = await db.query(
    "SELECT accepted FROM consents WHERE access_grant_id = $1 ORDER BY recorded_at DESC LIMIT 1",
    [grant.id],
  );
  if (consent.rows[0]?.accepted !== true)
    return reply.code(409).send({ error: "Einwilligung fehlt." });
  const existing = await db.query(
    "SELECT * FROM study_runs WHERE access_grant_id = $1",
    [grant.id],
  );
  if (
    existing.rowCount &&
    !(
      !isProduction &&
      existing.rows[0].protocol_version !== PROTOCOL_VERSION &&
      existing.rows[0].status !== "completed"
    )
  )
    return sanitizeRun(existing.rows[0], grant.study_type as string);
  if (existing.rowCount && !isProduction) {
    // Development-only rollover after a protocol change. Production runs are immutable.
    await db.query("DELETE FROM study_runs WHERE id = $1", [
      existing.rows[0].id,
    ]);
  }

  const workflowResult = grant.workflow_version_id
    ? await db.query("SELECT steps FROM workflow_definitions WHERE id = $1 AND status = 'published'", [grant.workflow_version_id])
    : null;
  const workflowSteps = (workflowResult?.rows[0]?.steps ?? []) as WorkflowStep[];
  if (grant.workflow_version_id && !workflowResult?.rowCount)
    return reply.code(409).send({ error: "The assigned workflow is no longer available." });
  if (grant.recruitment_source === "prolific" && grant.gender_identity === null)
    return reply.code(409).send({ error: "Please complete the face-set question before starting." });
  const hasTrustTask = grant.study_type === "investor" || workflowSteps.some((step) => step.moduleId === "trust-game");
  const seed = newToken(18);
  const selectedFaceSet = grant.face_set_preference === "male" || grant.face_set_preference === "female"
    ? grant.face_set_preference
    : undefined;
  const schedule = hasTrustTask
    ? createTrustSchedule(seed, {
        sex: selectedFaceSet ?? (grant.participant_sex === "male" || grant.participant_sex === "female" ? grant.participant_sex : undefined),
        cbGroup:
          grant.counterbalance_group === "CB1" ||
          grant.counterbalance_group === "CB2" ||
          grant.counterbalance_group === "CB3"
            ? grant.counterbalance_group
            : undefined,
      })
    : grant.study_type === "trustee"
      ? { protocolVersion: "trustee-norming-v1.0.0", investments: Array.from({ length: 11 }, (_, i) => i) }
      : { protocolVersion: `workflow-${grant.workflow_version_id ?? "questionnaire-only"}`, seed, trustTrials: [], riskTrials: [] };
  if (hasTrustTask) {
    const scheduleErrors = validateSchedule(schedule as ReturnType<typeof createTrustSchedule>);
    if (scheduleErrors.length)
      throw new Error(`Invalid Trust Game schedule: ${scheduleErrors.join("; ")}`);
  }
  const outcomeBankVersion =
    hasTrustTask ? "mri-probability-v1" : null;
  const scheduleHash = stableJsonHash(schedule);
  const requestedHost = request.headers["x-study-host"];
  const host = hostSchema.safeParse(requestedHost).success
    ? (requestedHost as string)
    : "portal";
  const headerValue = (name: string) => {
    const value = request.headers[name];
    return typeof value === "string" && value.length <= 160 ? value : null;
  };
  const inserted = await db.query(
    `INSERT INTO study_runs(access_grant_id, protocol_version, schema_version, seed, schedule_hash, outcome_bank_version, host, host_session_id, deployment_id, client_version, schedule, workflow_definition_id, recruitment_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [
      grant.id,
      schedule.protocolVersion,
      DATA_SCHEMA_VERSION,
      seed,
      scheduleHash,
      outcomeBankVersion,
      host,
      headerValue("x-study-session-id"),
      headerValue("x-study-deployment-id"),
      headerValue("x-study-client-version"),
      schedule,
      grant.workflow_version_id ?? null,
      grant.recruitment_source ?? "manual",
    ],
  );
  if (grant.workflow_version_id) {
    for (const step of workflowSteps) {
      await db.query(
        `INSERT INTO workflow_step_states(run_id, step_id, module_id, required)
         VALUES ($1,$2,$3,$4) ON CONFLICT (run_id, step_id) DO NOTHING`,
        [inserted.rows[0].id, step.id, step.moduleId, step.required],
      );
    }
  }
  await db.query(
    `INSERT INTO participant_events(access_grant_id, event_type, payload)
     VALUES ($1, 'run_created', $2)`,
    [grant.id, { runId: inserted.rows[0].id, workflowVersionId: grant.workflow_version_id ?? null }],
  );
  return sanitizeRun(inserted.rows[0], grant.study_type as string);
});

app.get("/api/runs/current", async (request, reply) => {
  const grant = await requireGrant(request, reply);
  if (!grant) return;
  const result = await db.query(
    "SELECT * FROM study_runs WHERE access_grant_id = $1",
    [grant.id],
  );
  if (!result.rowCount)
    return reply.code(404).send({ error: "Kein Durchlauf vorhanden." });
  const cursor = await db.query(
    "SELECT COALESCE(MAX(sequence), -1) AS sequence FROM trial_events WHERE run_id = $1",
    [result.rows[0].id],
  );
  const completed = await db.query(
    "SELECT DISTINCT trial_id FROM trial_events WHERE run_id = $1 AND event_type = 'trial_complete' AND trial_id IS NOT NULL",
    [result.rows[0].id],
  );
  return {
    ...sanitizeRun(result.rows[0], grant.study_type as string),
    lastSequence: Number(cursor.rows[0].sequence),
    completedTrialIds: completed.rows.map((row) => row.trial_id),
  };
});

app.post("/api/runs/:runId/workflow-step", async (request, reply) => {
  const grant = await requireGrant(request, reply);
  if (!grant) return;
  const params = z.object({ runId: z.string().uuid() }).safeParse(request.params);
  const body = z.object({
    stepId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    action: z.enum(["started", "completed", "failed"]),
    response: z.record(z.string(), z.unknown()).optional(),
  }).safeParse(request.body);
  if (!params.success || !body.success)
    return reply.code(400).send({ error: "Invalid workflow step event." });
  if (!grant.workflow_version_id)
    return reply.code(409).send({ error: "No workflow is assigned to this run." });
  const run = await db.query(
    "SELECT id, status FROM study_runs WHERE id = $1 AND access_grant_id = $2",
    [params.data.runId, grant.id],
  );
  if (!run.rowCount) return reply.code(404).send({ error: "Run not found." });
  if (run.rows[0].status === "completed")
    return reply.code(409).send({ error: "The completed record is immutable." });
  if (run.rows[0].status !== "running")
    return reply.code(409).send({ error: "Start the study before advancing workflow steps." });
  const state = await db.query(
    `SELECT s.*, d.steps FROM workflow_step_states s
     JOIN study_runs r ON r.id = s.run_id
     JOIN workflow_definitions d ON d.id = r.workflow_definition_id
     WHERE s.run_id = $1 AND s.step_id = $2 AND d.id = $3`,
    [params.data.runId, body.data.stepId, grant.workflow_version_id],
  );
  if (!state.rowCount) return reply.code(404).send({ error: "Workflow step not found." });
  const orderedSteps = state.rows[0].steps as WorkflowStep[];
  const currentPosition = orderedSteps.findIndex((step) => step.id === body.data.stepId);
  const priorRequiredIds = orderedSteps.slice(0, currentPosition).filter((step) => step.required).map((step) => step.id);
  if (priorRequiredIds.length) {
    const prior = await db.query(
      "SELECT step_id, status FROM workflow_step_states WHERE run_id = $1 AND step_id = ANY($2::text[])",
      [params.data.runId, priorRequiredIds],
    );
    if (prior.rows.some((row) => row.status !== "completed"))
      return reply.code(409).send({ error: "Complete the earlier required workflow steps first." });
  }
  if (body.data.action === "started" && ["in_progress", "completed"].includes(state.rows[0].status))
    return { ok: true, status: state.rows[0].status };
  if (body.data.action === "failed" && state.rows[0].status === "failed")
    return { ok: true, status: "failed" };
  if (body.data.action === "completed") {
    if (state.rows[0].status === "completed") return { ok: true, status: "completed" };
    if (state.rows[0].module_id === "trust-game") {
      const [outcomes, trials] = await Promise.all([
        db.query("SELECT count(*)::int AS n FROM outcome_resolutions WHERE run_id = $1", [params.data.runId]),
        db.query("SELECT count(DISTINCT trial_id)::int AS n FROM trial_events WHERE run_id = $1 AND event_type = 'trial_complete' AND payload->>'domain' = 'trust'", [params.data.runId]),
      ]);
      if (Number(outcomes.rows[0].n) < 72 || Number(trials.rows[0].n) < 72)
        return reply.code(409).send({ error: "The Trust Game step is not complete on the server." });
    } else if (state.rows[0].module_id.startsWith("questionnaire:")) {
      if (!body.data.response || JSON.stringify(body.data.response).length > 100_000)
        return reply.code(400).send({ error: "Questionnaire responses are missing or too large." });
      const instrument = questionnaireById(state.rows[0].module_id);
      if (!instrument || body.data.response.instrumentVersion !== instrument.version)
        return reply.code(409).send({ error: "Questionnaire version does not match the published instrument." });
      const checked = validateQuestionnaireResponses(state.rows[0].module_id, body.data.response.responses);
      if (!checked.ok) return reply.code(400).send({ error: checked.error });
    }
    await db.query(
      `UPDATE workflow_step_states SET status = 'completed', started_at = COALESCE(started_at, now()),
         completed_at = now(), response = COALESCE($3, response)
       WHERE run_id = $1 AND step_id = $2`,
      [params.data.runId, body.data.stepId, body.data.response ?? null],
    );
  } else {
    const nextStatus = body.data.action === "started" ? "in_progress" : "failed";
    await db.query(
      `UPDATE workflow_step_states SET status = $3, started_at = COALESCE(started_at, now())
       WHERE run_id = $1 AND step_id = $2 AND status <> 'completed'`,
      [params.data.runId, body.data.stepId, nextStatus],
    );
  }
  await db.query(
    `INSERT INTO participant_events(access_grant_id, event_type, payload)
     VALUES ($1, $2, $3)`,
    [grant.id, `workflow_step_${body.data.action}`, { runId: params.data.runId, stepId: body.data.stepId, moduleId: state.rows[0].module_id }],
  );
  return { ok: true, status: body.data.action === "completed" ? "completed" : body.data.action === "started" ? "in_progress" : "failed" };
});

app.post("/api/runs/:runId/start", async (request, reply) => {
  const grant = await requireGrant(request, reply);
  if (!grant) return;
  const runId = z
    .string()
    .uuid()
    .safeParse((request.params as any).runId);
  if (!runId.success)
    return reply.code(400).send({ error: "Ungültiger Durchlauf." });
  const result = await db.query(
    `UPDATE study_runs SET status = 'running', started_at = COALESCE(started_at, now())
     WHERE id = $1 AND access_grant_id = $2 AND status IN ('created', 'running') RETURNING id, status, started_at`,
    [runId.data, grant.id],
  );
  if (!result.rowCount)
    return reply
      .code(409)
      .send({ error: "Durchlauf kann nicht gestartet werden." });
  return result.rows[0];
});

app.post("/api/runs/:runId/events", async (request, reply) => {
  const grant = await requireGrant(request, reply);
  if (!grant) return;
  const params = z
    .object({ runId: z.string().uuid() })
    .safeParse(request.params);
  const body = z
    .object({ events: z.array(eventSchema).min(1).max(100) })
    .safeParse(request.body);
  if (!params.success || !body.success)
    return reply.code(400).send({ error: "Ungültige Ereignisdaten." });
  const owns = await db.query(
    "SELECT status FROM study_runs WHERE id = $1 AND access_grant_id = $2",
    [params.data.runId, grant.id],
  );
  if (!owns.rowCount)
    return reply.code(404).send({ error: "Durchlauf nicht gefunden." });
  if (owns.rows[0].status === "completed")
    return reply
      .code(409)
      .send({ error: "Der abgeschlossene Datensatz ist unveränderlich." });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const event of body.data.events) {
      await client.query(
        `INSERT INTO trial_events(run_id, sequence, event_id, event_type, trial_id, client_time_ms, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [
          params.data.runId,
          event.sequence,
          event.eventId,
          event.eventType,
          event.trialId ?? null,
          event.clientTimeMs,
          event.payload,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const cursor = await db.query(
    "SELECT COALESCE(MAX(sequence), -1) AS sequence FROM trial_events WHERE run_id = $1",
    [params.data.runId],
  );
  return { acceptedThrough: Number(cursor.rows[0].sequence) };
});

app.post("/api/runs/:runId/outcome", async (request, reply) => {
  const grant = await requireGrant(request, reply);
  if (!grant) return;
  const params = z
    .object({ runId: z.string().uuid() })
    .safeParse(request.params);
  const body = z
    .object({
      trialId: z.string(),
      profile: z.enum(["low", "neutral", "high"]),
      investment: z.number().min(0).max(1),
      chosenSide: z.enum(["left", "right"]).optional(),
    })
    .safeParse(request.body);
  if (!params.success || !body.success)
    return reply.code(400).send({ error: "Ungültige Auszahlungsanfrage." });
  const runResult = await db.query(
    "SELECT * FROM study_runs WHERE id = $1 AND access_grant_id = $2",
    [params.data.runId, grant.id],
  );
  if (!runResult.rowCount)
    return reply.code(404).send({ error: "Durchlauf nicht gefunden." });
  const run = runResult.rows[0];
  if (run.status === "completed")
    return reply
      .code(409)
      .send({ error: "Der abgeschlossene Datensatz ist unveränderlich." });
  const spec = run.schedule.trustTrials?.find(
    (trial: any) => trial.trialId === body.data.trialId,
  );
  if (
    !spec ||
    (spec.condition !== "learning" &&
      body.data.profile !== "neutral" &&
      !spec.offeredProfiles.includes(body.data.profile))
  )
    return reply
      .code(409)
      .send({ error: "Antwort passt nicht zum Versuchsplan." });
  const prior = await db.query(
    "SELECT result, investment, profile FROM outcome_resolutions WHERE run_id = $1 AND trial_id = $2",
    [run.id, body.data.trialId],
  );
  if (prior.rowCount) {
    if (
      prior.rows[0].investment !== body.data.investment ||
      prior.rows[0].profile !== body.data.profile
    ) {
      return reply
        .code(409)
        .send({ error: "Diese Entscheidung wurde bereits bestätigt." });
    }
    return prior.rows[0].result;
  }
  const condition =
    spec.condition === "punishment"
      ? "punishment"
      : spec.condition === "learning"
        ? "learning"
        : "reward";
  if (condition === "learning") {
    const correct = body.data.chosenSide === spec.correctSide;
    const investment = Math.round(body.data.investment * 100) / 100;
    const result = {
      policyId: "learning-deterministic",
      invested: investment,
      tripled: investment * 3,
      returned: correct ? investment * 2 : 0,
      payoff: 1 - investment + (correct ? investment * 2 : 0),
      net: correct ? investment : -investment,
      outcomeType: correct ? "win" : "lose",
      condition,
      probability: correct ? 1 : 0,
      randomDraw: null,
    };
    await db.query(
      `INSERT INTO outcome_resolutions(run_id, trial_id, profile, investment, result) VALUES ($1,$2,$3,$4,$5)`,
      [run.id, body.data.trialId, body.data.profile, investment, result],
    );
    return result;
  }
  const probabilities: Record<string, number> =
    condition === "reward"
      ? { high: 0.75, neutral: 0.5, low: 0.25 }
      : { high: 0.25, neutral: 0.5, low: 0.75 };
  const draw =
    Number.parseInt(
      stableJsonHash(`${run.seed}:${body.data.trialId}`).slice(0, 8),
      16,
    ) / 0xffffffff;
  const favorable = draw < probabilities[body.data.profile];
  const investment = Math.round(body.data.investment * 100) / 100;
  const outcomeType =
    condition === "reward"
      ? favorable
        ? "win"
        : "break_even"
      : favorable
        ? "break_even"
        : "lose";
  const netRate = outcomeType === "win" ? 1 : outcomeType === "lose" ? -1 : 0;
  const returned =
    outcomeType === "win"
      ? investment * 2
      : outcomeType === "break_even"
        ? investment
        : 0;
  const result = {
    policyId: `mri-probability-${spec.condition}-${body.data.profile}`,
    invested: investment,
    tripled: investment * 3,
    returned,
    payoff: 1 - investment + returned,
    net: netRate * investment,
    outcomeType,
    condition,
    probability: probabilities[body.data.profile],
    randomDraw: draw,
  };
  await db.query(
    `INSERT INTO outcome_resolutions(run_id, trial_id, profile, investment, result) VALUES ($1,$2,$3,$4,$5)`,
    [run.id, body.data.trialId, body.data.profile, investment, result],
  );
  return result;
});

app.post("/api/runs/:runId/risk-outcome", async (request, reply) => {
  const grant = await requireGrant(request, reply);
  if (!grant) return;
  const params = z
    .object({ runId: z.string().uuid() })
    .safeParse(request.params);
  const body = z
    .object({ trialId: z.string(), choice: z.enum(["sure", "gamble"]) })
    .safeParse(request.body);
  if (!params.success || !body.success)
    return reply.code(400).send({ error: "Ungültige Risikoentscheidung." });
  const runResult = await db.query(
    "SELECT * FROM study_runs WHERE id = $1 AND access_grant_id = $2",
    [params.data.runId, grant.id],
  );
  if (!runResult.rowCount)
    return reply.code(404).send({ error: "Durchlauf nicht gefunden." });
  const run = runResult.rows[0];
  if (run.status === "completed")
    return reply
      .code(409)
      .send({ error: "Der abgeschlossene Datensatz ist unveränderlich." });
  const spec = run.schedule.riskTrials?.find(
    (trial: any) => trial.trialId === body.data.trialId,
  );
  if (!spec)
    return reply
      .code(409)
      .send({ error: "Risikoentscheidung passt nicht zum Versuchsplan." });
  const prior = await db.query(
    "SELECT result, choice FROM risk_resolutions WHERE run_id = $1 AND trial_id = $2",
    [run.id, body.data.trialId],
  );
  if (prior.rowCount) {
    if (prior.rows[0].choice !== body.data.choice)
      return reply
        .code(409)
        .send({ error: "Diese Entscheidung wurde bereits bestätigt." });
    return prior.rows[0].result;
  }
  const uniform =
    Number.parseInt(
      stableJsonHash(`${run.seed}:${body.data.trialId}`).slice(0, 8),
      16,
    ) / 0xffffffff;
  const realized =
    body.data.choice === "sure"
      ? spec.sureTokens
      : uniform < spec.gainProbability
        ? spec.gainTokens
        : spec.lossTokens;
  const result = {
    choice: body.data.choice,
    realizedTokens: realized,
    randomDraw: uniform,
  };
  await db.query(
    "INSERT INTO risk_resolutions(run_id, trial_id, choice, result) VALUES ($1,$2,$3,$4)",
    [run.id, body.data.trialId, body.data.choice, result],
  );
  return result;
});

app.post("/api/runs/:runId/trustee-policy", async (request, reply) => {
  const grant = await requireGrant(request, reply);
  if (!grant || grant.study_type !== "trustee")
    return reply
      .code(403)
      .send({ error: "Nicht für diesen Studientyp verfügbar." });
  const params = z
    .object({ runId: z.string().uuid() })
    .safeParse(request.params);
  const body = z
    .object({
      returnsByInvestment: z.array(z.number().int().nonnegative()).length(11),
    })
    .safeParse(request.body);
  if (
    !params.success ||
    !body.success ||
    body.data.returnsByInvestment.some((value, i) => value > i * 3)
  ) {
    return reply.code(400).send({ error: "Ungültige Rückgabeentscheidungen." });
  }
  const owns = await db.query(
    "SELECT status FROM study_runs WHERE id = $1 AND access_grant_id = $2",
    [params.data.runId, grant.id],
  );
  if (!owns.rowCount)
    return reply.code(404).send({ error: "Durchlauf nicht gefunden." });
  if (owns.rows[0].status === "completed")
    return reply
      .code(409)
      .send({ error: "Der abgeschlossene Datensatz ist unveränderlich." });
  await db.query(
    `INSERT INTO trustee_policies(run_id, returns_by_investment, quality_passed)
     VALUES ($1,$2,false) ON CONFLICT (run_id) DO UPDATE SET returns_by_investment = EXCLUDED.returns_by_investment, quality_passed = false`,
    [params.data.runId, JSON.stringify(body.data.returnsByInvestment)],
  );
  return { ok: true };
});

app.post("/api/runs/:runId/complete", async (request, reply) => {
  const grant = await requireGrant(request, reply);
  if (!grant) return;
  const params = z
    .object({ runId: z.string().uuid() })
    .safeParse(request.params);
  const body = z
    .object({ summary: z.record(z.string(), z.unknown()) })
    .safeParse(request.body);
  if (!params.success || !body.success)
    return reply.code(400).send({ error: "Ungültiger Abschluss." });
  const run = await db.query(
    "SELECT * FROM study_runs WHERE id = $1 AND access_grant_id = $2",
    [params.data.runId, grant.id],
  );
  if (!run.rowCount)
    return reply.code(404).send({ error: "Durchlauf nicht gefunden." });
  if (run.rows[0].status === "completed") {
    const existing = await db.query("SELECT completion_code FROM completions WHERE run_id = $1", [params.data.runId]);
    const bonus = await db.query("SELECT amount_eur FROM bonuses WHERE run_id = $1", [params.data.runId]);
    const mapping = grant.recruitment_source === "prolific"
      ? await db.query("SELECT completion_url FROM prolific_studies WHERE prolific_study_id = $1", [grant.prolific_study_id])
      : null;
    return {
      completionCode: existing.rows[0]?.completion_code ?? "",
      bonusEur: Number(bonus.rows[0]?.amount_eur ?? 0),
      completionRedirectUrl: mapping?.rows[0]?.completion_url ?? null,
    };
  }
  if (run.rows[0].status !== "running")
    return reply.code(409).send({ error: "Start the study before completing it." });
  const workflowStepsResult = grant.workflow_version_id
    ? await db.query("SELECT steps FROM workflow_definitions WHERE id = $1", [grant.workflow_version_id])
    : null;
  const workflowSteps = (workflowStepsResult?.rows[0]?.steps ?? []) as WorkflowStep[];
  const hasTrustTask = grant.study_type === "investor" || workflowSteps.some((step) => step.moduleId === "trust-game");
  if (grant.recruitment_source === "prolific" && grant.workflow_version_id) {
    const states = await db.query(
      "SELECT step_id, status, required FROM workflow_step_states WHERE run_id = $1",
      [params.data.runId],
    );
    const byId = new Map(states.rows.map((state) => [state.step_id, state]));
    const missing = workflowSteps.filter((step) => step.required && byId.get(step.id)?.status !== "completed");
    if (missing.length)
      return reply.code(409).send({
        error: "Der Durchlauf ist noch nicht vollständig.",
        incompleteSteps: missing.map((step) => step.id),
      });
  }
  let qualityStatus: "pass" | "review" = "review";
  let serverQuality: Record<string, unknown> = {};
  if (hasTrustTask) {
    const outcomes = await db.query(
      "SELECT count(*)::int AS count FROM outcome_resolutions WHERE run_id = $1",
      [params.data.runId],
    );
    if (outcomes.rows[0].count < 72)
      return reply
        .code(409)
        .send({ error: "Der Durchlauf ist noch nicht vollständig." });
    const completedEvents = await db.query(
      `SELECT payload->>'domain' AS domain, count(DISTINCT trial_id)::int AS count
       FROM trial_events WHERE run_id = $1 AND event_type = 'trial_complete'
       GROUP BY payload->>'domain'`,
      [params.data.runId],
    );
    const counts = Object.fromEntries(
      completedEvents.rows.map((row) => [row.domain, row.count]),
    );
    if ((counts.trust ?? 0) < 72) {
      return reply.code(409).send({
        error: "Die Versuchsdaten wurden noch nicht vollständig übertragen.",
      });
    }
    const quality = await db.query(
      `SELECT
         count(*) FILTER (WHERE event_type = 'trial_complete' AND payload->>'omitted' = 'true')::int AS omissions,
         count(*) FILTER (WHERE event_type = 'browser_interaction')::int AS browser_interactions,
         bool_or(event_type = 'comprehension_attempt' AND payload->>'correct' = 'true') AS comprehension_passed
       FROM trial_events WHERE run_id = $1`,
      [params.data.runId],
    );
    const seriousness = await db.query(
      `SELECT payload->>'serious' AS serious FROM trial_events
       WHERE run_id = $1 AND event_type = 'seriousness_check' ORDER BY sequence DESC LIMIT 1`,
      [params.data.runId],
    );
    const serious = seriousness.rows[0]?.serious === "true";
    serverQuality = { ...quality.rows[0], seriousnessConfirmed: serious };
    qualityStatus =
      quality.rows[0].omissions === 0 &&
      quality.rows[0].comprehension_passed === true &&
      serious
        ? "pass"
        : "review";
  } else if (grant.study_type === "trustee") {
    const policy = await db.query(
      "SELECT 1 FROM trustee_policies WHERE run_id = $1",
      [params.data.runId],
    );
    if (!policy.rowCount)
      return reply
        .code(409)
        .send({ error: "Die Entscheidungen wurden noch nicht gespeichert." });
    const decisions = await db.query(
      `SELECT count(DISTINCT trial_id) FILTER (WHERE event_type = 'trustee_decision')::int AS count,
              bool_or(event_type = 'comprehension_attempt' AND payload->>'correct' = 'true') AS comprehension_passed
       FROM trial_events WHERE run_id = $1`,
      [params.data.runId],
    );
    if (
      decisions.rows[0].count < 11 ||
      decisions.rows[0].comprehension_passed !== true
    )
      return reply.code(409).send({
        error: "Die Versuchsdaten wurden noch nicht vollständig übertragen.",
      });
  } else {
    qualityStatus = "pass";
    serverQuality = { workflowOnly: true };
  }
  const completionCode = newCode();
  const client = await db.connect();
  let bonusEur = 0;
  try {
    await client.query("BEGIN");
    if (hasTrustTask) {
      const allOutcomes = await client.query(
        "SELECT trial_id, result FROM outcome_resolutions WHERE run_id = $1",
        [params.data.runId],
      );
      const selected = allOutcomes.rows
        .slice()
        .sort((a, b) =>
          stableJsonHash(`${run.rows[0].seed}:${a.trial_id}`).localeCompare(
            stableJsonHash(`${run.rows[0].seed}:${b.trial_id}`),
          ),
        )
        .slice(0, 10);
      bonusEur =
        Math.round(
          (selected.reduce((sum, row) => sum + Number(row.result.payoff), 0) /
            30) *
            500,
        ) / 100;
      await client.query(
        `INSERT INTO bonuses(run_id, selected_trial_ids, amount_eur, calculation_version)
         VALUES ($1,$2,$3,'trust-10-of-72-v2') ON CONFLICT (run_id) DO NOTHING`,
        [
          params.data.runId,
          JSON.stringify(selected.map((row) => row.trial_id)),
          bonusEur,
        ],
      );
    } else if (grant.study_type === "trustee") {
      const policy = await client.query(
        "SELECT returns_by_investment FROM trustee_policies WHERE run_id = $1",
        [params.data.runId],
      );
      const selectedInvestment =
        1 +
        (Number.parseInt(
          stableJsonHash(`${run.rows[0].seed}:trustee-bonus`).slice(0, 8),
          16,
        ) %
          10);
      const returned = Number(
        policy.rows[0].returns_by_investment[selectedInvestment],
      );
      const retained = selectedInvestment * 3 - returned;
      bonusEur = Math.round((retained / 30) * 500) / 100;
      await client.query(
        `INSERT INTO bonuses(run_id, selected_trial_ids, amount_eur, calculation_version)
         VALUES ($1,$2,$3,'trustee-one-of-10-v1') ON CONFLICT (run_id) DO NOTHING`,
        [
          params.data.runId,
          JSON.stringify([`trustee-${selectedInvestment}`]),
          bonusEur,
        ],
      );
    }
    await client.query(
      `INSERT INTO completions(run_id, completion_code, quality_status, summary)
       VALUES ($1,$2,$3,$4) ON CONFLICT (run_id) DO NOTHING`,
      [
        params.data.runId,
        completionCode,
        qualityStatus,
        { ...body.data.summary, serverQuality },
      ],
    );
    await client.query(
      "UPDATE study_runs SET status = 'completed', completed_at = now() WHERE id = $1",
      [params.data.runId],
    );
    await client.query(
      "UPDATE access_grants SET status = 'completed', completed_at = now() WHERE id = $1",
      [grant.id],
    );
    if (grant.recruitment_source === "prolific") {
      await client.query(
        `INSERT INTO firebase_exports(run_id, status) VALUES ($1, 'pending')
         ON CONFLICT (run_id) DO UPDATE SET status = 'pending', updated_at = now()`,
        [params.data.runId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const saved = await db.query(
    "SELECT completion_code FROM completions WHERE run_id = $1",
    [params.data.runId],
  );
  const bonus = await db.query(
    "SELECT amount_eur FROM bonuses WHERE run_id = $1",
    [params.data.runId],
  );
  const prolificStudy = grant.recruitment_source === "prolific"
    ? await db.query("SELECT completion_url FROM prolific_studies WHERE prolific_study_id = $1", [grant.prolific_study_id])
    : null;
  if (grant.recruitment_source === "prolific") void processFirebaseExports();
  return {
    completionCode: saved.rows[0]?.completion_code ?? completionCode,
    bonusEur: Number(bonus.rows[0]?.amount_eur ?? bonusEur),
    completionRedirectUrl: prolificStudy?.rows[0]?.completion_url ?? null,
  };
});

app.post("/api/admin/codes", async (request, reply) => {
  const actor = await requireAdmin(request, reply);
  if (!actor) return;
  const body = z
    .object({
      count: z.number().int().min(1).max(500),
      studyType: z.enum(["investor", "trustee"]),
      sex: z.enum(["male", "female"]).optional(),
      counterbalanceGroup: z.enum(["CB1", "CB2", "CB3"]).optional(),
      validDays: z.number().int().min(1).max(365).default(30),
    })
    .safeParse(request.body);
  if (!body.success)
    return reply.code(400).send({ error: "Invalid code request" });
  const codes: string[] = [];
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Mirror the MRI assignment rule: participant numbers divisible by 3
    // receive CB3, other even numbers CB2, and the remainder CB1.
    await client.query("SELECT pg_advisory_xact_lock(471903)");
    const existingParticipants = await client.query(
      "SELECT count(*)::int AS count FROM access_grants WHERE study_type = 'investor'",
    );
    const firstParticipantNumber = Number(existingParticipants.rows[0].count) + 1;
    for (let i = 0; i < body.data.count; i += 1) {
      const sex = body.data.sex ?? (i % 2 === 0 ? "male" : "female");
      const participantNumber = firstParticipantNumber + i;
      const automaticCounterbalance =
        participantNumber % 3 === 0
          ? "CB3"
          : participantNumber % 2 === 0
            ? "CB2"
            : "CB1";
      const counterbalanceGroup =
        body.data.counterbalanceGroup ?? automaticCounterbalance;
      const code =
        body.data.studyType === "investor"
          ? newParticipantCode(sex, counterbalanceGroup)
          : newCode();
      await client.query(
        `INSERT INTO access_grants(code_hash, study_type, participant_sex, counterbalance_group, protocol_version, expires_at)
         VALUES ($1,$2,$3,$4,$5,now() + ($6 || ' days')::interval)`,
        [
          digest(normalizeCode(code)),
          body.data.studyType,
          body.data.studyType === "investor" ? sex : null,
          body.data.studyType === "investor" ? counterbalanceGroup : null,
          PROTOCOL_VERSION,
          body.data.validDays,
        ],
      );
      codes.push(code);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(actor, "codes.generate", {
    count: codes.length,
    studyType: body.data.studyType,
  });
  return { codes };
});

app.get("/api/admin/workflow-modules", async (request, reply) => {
  const actor = await requireAdmin(request, reply);
  if (!actor) return;
  return { modules: WORKFLOW_MODULES };
});

app.get("/api/admin/workflows", async (request, reply) => {
  const actor = await requireAdmin(request, reply);
  if (!actor) return;
  const result = await db.query(
    `SELECT d.id, d.name, d.version, d.status, d.steps, d.content_hash, d.created_at,
            d.published_at, p.prolific_study_id, p.active AS prolific_active,
            p.completion_url
     FROM workflow_definitions d LEFT JOIN prolific_studies p ON p.workflow_definition_id = d.id
     ORDER BY d.name, d.version DESC`,
  );
  return { workflows: result.rows };
});

app.post("/api/admin/workflows", async (request, reply) => {
  const actor = await requireAdmin(request, reply);
  if (!actor) return;
  const parsed = z.object({
    name: z.string().trim().min(3).max(100).regex(/^[\p{L}\p{N} ._-]+$/u),
    steps: z.unknown(),
  }).safeParse(request.body);
  if (!parsed.success)
    return reply.code(400).send({ error: "Invalid workflow name or steps." });
  const valid = validateWorkflowSteps(parsed.data.steps);
  if (!valid.ok) return reply.code(400).send({ error: valid.error });
  const client = await db.connect();
  let inserted;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(705119)");
    const latest = await client.query(
      "SELECT COALESCE(MAX(version), 0)::int AS version FROM workflow_definitions WHERE name = $1",
      [parsed.data.name],
    );
    inserted = await client.query(
      `INSERT INTO workflow_definitions(name, version, status, steps, content_hash, created_by)
       VALUES ($1, $2, 'draft', $3, $4, $5) RETURNING *`,
      [parsed.data.name, Number(latest.rows[0].version) + 1, valid.steps,
        stableJsonHash(valid.steps), actor],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(actor, "workflow.draft.create", { id: inserted.rows[0].id, name: parsed.data.name });
  return { workflow: inserted.rows[0] };
});

app.post("/api/admin/workflows/:id/publish", async (request, reply) => {
  const actor = await requireAdmin(request, reply);
  if (!actor) return;
  const id = z.string().uuid().safeParse((request.params as any).id);
  if (!id.success) return reply.code(400).send({ error: "Invalid workflow ID." });
  const existing = await db.query("SELECT * FROM workflow_definitions WHERE id = $1", [id.data]);
  if (!existing.rowCount) return reply.code(404).send({ error: "Workflow not found." });
  const valid = validateWorkflowSteps(existing.rows[0].steps);
  if (!valid.ok) return reply.code(409).send({ error: valid.error });
  if (existing.rows[0].status !== "draft")
    return reply.code(409).send({ error: "Published workflow versions are immutable." });
  const published = await db.query(
    `UPDATE workflow_definitions SET status = 'published', published_at = now()
     WHERE id = $1 AND status = 'draft' RETURNING *`,
    [id.data],
  );
  await audit(actor, "workflow.publish", { id: id.data, contentHash: published.rows[0].content_hash });
  return { workflow: published.rows[0] };
});

app.post("/api/admin/prolific-studies", async (request, reply) => {
  const actor = await requireAdmin(request, reply);
  if (!actor) return;
  const body = z.object({
    prolificStudyId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    workflowDefinitionId: z.string().uuid(),
    completionUrl: completionUrlSchema(),
    active: z.boolean().default(false),
  }).safeParse(request.body);
  if (!body.success) return reply.code(400).send({ error: "Invalid Prolific study mapping." });
  if (isProduction && body.data.active && process.env.CONSENT_RELEASED !== "true")
    return reply.code(409).send({ error: "Production consent has not been released; this Prolific study cannot be activated." });
  const workflow = await db.query(
    "SELECT id, status FROM workflow_definitions WHERE id = $1",
    [body.data.workflowDefinitionId],
  );
  if (!workflow.rowCount || workflow.rows[0].status !== "published")
    return reply.code(409).send({ error: "Only a published workflow can be mapped to Prolific." });
  const saved = await db.query(
    `INSERT INTO prolific_studies(prolific_study_id, workflow_definition_id, completion_url, active, created_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (prolific_study_id) DO UPDATE SET workflow_definition_id = EXCLUDED.workflow_definition_id,
       completion_url = EXCLUDED.completion_url, active = EXCLUDED.active, updated_at = now()
     RETURNING *`,
    [body.data.prolificStudyId, body.data.workflowDefinitionId, body.data.completionUrl,
      body.data.active, actor],
  );
  await audit(actor, "prolific-study.configure", {
    studyId: body.data.prolificStudyId,
    workflowDefinitionId: body.data.workflowDefinitionId,
    active: body.data.active,
  });
  return { study: saved.rows[0] };
});

app.get("/api/admin/summary", async (request, reply) => {
  const actor = await requireAdmin(request, reply);
  if (!actor) return;
  const grants = await db.query(
    "SELECT study_type, status, count(*)::int AS count FROM access_grants GROUP BY study_type, status ORDER BY study_type, status",
  );
  const bank = await db.query(
    "SELECT version, source, content_hash, created_at FROM outcome_banks WHERE active = true LIMIT 1",
  );
  const policies = await db.query(
    "SELECT count(*)::int AS count, count(*) FILTER (WHERE quality_passed)::int AS passed FROM trustee_policies",
  );
  return {
    protocolVersion: PROTOCOL_VERSION,
    grants: grants.rows,
    activeBank: bank.rows[0] ?? null,
    trusteePolicies: policies.rows[0],
  };
});

app.get("/api/admin/codes", async (request, reply) => {
  const actor = await requireAdmin(request, reply);
  if (!actor) return;
  const grants = await db.query(
    `SELECT g.id, g.study_type, g.participant_sex, g.counterbalance_group, g.status,
            g.expires_at, g.created_at, g.completed_at, g.recruitment_source,
            g.prolific_pid, g.prolific_study_id, g.prolific_session_id,
            g.gender_identity, g.face_set_preference,
            r.id AS run_id, r.status AS run_status, r.started_at, r.completed_at AS run_completed_at,
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'stepId', w.step->>'id', 'moduleId', w.step->>'moduleId',
              'status', COALESCE(s.status, 'not_started'),
              'startedAt', s.started_at, 'completedAt', s.completed_at
            ) ORDER BY w.ordinality)
             FROM workflow_definitions d
             CROSS JOIN LATERAL jsonb_array_elements(d.steps) WITH ORDINALITY AS w(step, ordinality)
             LEFT JOIN workflow_step_states s ON s.run_id = r.id AND s.step_id = w.step->>'id'
             WHERE d.id = g.workflow_version_id), '[]'::jsonb) AS workflow_progress,
            e.status AS firebase_export_status
     FROM access_grants g
     LEFT JOIN study_runs r ON r.access_grant_id = g.id
     LEFT JOIN firebase_exports e ON e.run_id = r.id
     ORDER BY g.created_at DESC LIMIT 500`,
  );
  return { grants: grants.rows };
});

app.post("/api/admin/codes/:id/revoke", async (request, reply) => {
  const actor = await requireAdmin(request, reply);
  if (!actor) return;
  const id = z
    .string()
    .uuid()
    .safeParse((request.params as any).id);
  if (!id.success) return reply.code(400).send({ error: "Invalid grant ID" });
  await db.query(
    "UPDATE access_grants SET status = 'revoked' WHERE id = $1 AND status <> 'completed'",
    [id.data],
  );
  await audit(actor, "code.revoke", { id: id.data });
  return { ok: true };
});

app.get("/api/admin/trustee-policies", async (request, reply) => {
  const actor = await requireAdmin(request, reply);
  if (!actor) return;
  const policies = await db.query(
    `SELECT p.id, p.returns_by_investment, p.quality_passed, p.created_at,
            c.quality_status, r.completed_at, metrics.decision_count, metrics.average_rt_ms
     FROM trustee_policies p
     JOIN study_runs r ON r.id = p.run_id
     LEFT JOIN completions c ON c.run_id = r.id
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS decision_count,
              round(avg((e.payload->>'rt_ms')::numeric), 0) AS average_rt_ms
       FROM trial_events e WHERE e.run_id = r.id AND e.event_type = 'trustee_decision'
     ) metrics ON true
     ORDER BY p.created_at DESC`,
  );
  return { policies: policies.rows };
});

app.post("/api/admin/trustee-policies/:id/quality", async (request, reply) => {
  const actor = await requireAdmin(request, reply);
  if (!actor) return;
  const id = z
    .string()
    .uuid()
    .safeParse((request.params as any).id);
  const body = z.object({ passed: z.boolean() }).safeParse(request.body);
  if (!id.success || !body.success)
    return reply.code(400).send({ error: "Invalid quality decision" });
  const result = await db.query(
    "UPDATE trustee_policies SET quality_passed = $2 WHERE id = $1 RETURNING id, quality_passed",
    [id.data, body.data.passed],
  );
  if (!result.rowCount)
    return reply.code(404).send({ error: "Trustee policy not found" });
  await audit(actor, "trustee-policy.quality", {
    id: id.data,
    passed: body.data.passed,
  });
  return result.rows[0];
});

app.post("/api/admin/outcome-bank/build", async (request, reply) => {
  const actor = await requireAdmin(request, reply);
  if (!actor) return;
  const body = z
    .object({ version: z.string().regex(/^[a-zA-Z0-9._-]{3,80}$/) })
    .safeParse(request.body);
  if (!body.success)
    return reply.code(400).send({ error: "Invalid bank version" });
  const result = await db.query(
    "SELECT id, returns_by_investment, quality_passed FROM trustee_policies ORDER BY created_at",
  );
  const policies: TrusteePolicy[] = result.rows.map((row) => ({
    policyId: row.id,
    returnsByInvestment: row.returns_by_investment,
    qualityPassed: row.quality_passed,
  }));
  let bank: OutcomeBank;
  try {
    bank = buildRecordedBank(policies, body.data.version);
  } catch (error) {
    return reply
      .code(409)
      .send({ error: error instanceof Error ? error.message : String(error) });
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE outcome_banks SET active = false");
    await client.query(
      `INSERT INTO outcome_banks(version, source, content_hash, bank, active) VALUES ($1,$2,$3,$4,true)`,
      [bank.version, bank.source, stableJsonHash(bank), bank],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(actor, "outcome-bank.build", {
    version: bank.version,
    policies: policies.length,
  });
  return { version: bank.version, hash: stableJsonHash(bank) };
});

async function researchExport(grantId?: string) {
  const runs = await db.query(
    `SELECT r.id AS run_id, r.protocol_version, r.schema_version, r.schedule_hash, r.outcome_bank_version,
            r.host, r.host_session_id, r.deployment_id, r.client_version,
            r.status, r.started_at, r.completed_at, g.study_type, g.participant_sex, g.counterbalance_group,
            r.workflow_definition_id, r.recruitment_source,
            g.prolific_pid, g.prolific_study_id, g.prolific_session_id,
            g.gender_identity, g.face_set_preference,
            c.completion_code, c.quality_status, c.summary, b.amount_eur AS bonus_eur
     FROM study_runs r JOIN access_grants g ON g.id = r.access_grant_id
     LEFT JOIN completions c ON c.run_id = r.id
     LEFT JOIN bonuses b ON b.run_id = r.id
     WHERE ($1::uuid IS NULL OR r.access_grant_id = $1)
     ORDER BY r.created_at`,
    [grantId ?? null],
  );
  const events = await db.query(
    `SELECT run_id, sequence, event_type, trial_id, client_time_ms, server_time, payload
     FROM trial_events
     WHERE ($1::uuid IS NULL OR run_id IN (
       SELECT id FROM study_runs WHERE access_grant_id = $1
     ))
     ORDER BY run_id, sequence`,
    [grantId ?? null],
  );
  const participantEvents = await db.query(
    `SELECT access_grant_id, event_type, client_time_ms, server_time, payload
     FROM participant_events
     WHERE ($1::uuid IS NULL OR access_grant_id = $1)
     ORDER BY access_grant_id, id`,
    [grantId ?? null],
  );
  const workflowSteps = await db.query(
    `SELECT s.run_id, s.step_id, s.module_id, s.required, s.status,
            s.started_at, s.completed_at, s.response
     FROM workflow_step_states s JOIN study_runs r ON r.id = s.run_id
     WHERE ($1::uuid IS NULL OR r.access_grant_id = $1)
     ORDER BY s.run_id, s.step_id`,
    [grantId ?? null],
  );
  const runMetadata = new Map(
    runs.rows.map((run) => [run.run_id, run]),
  );
  const trialRows = events.rows
    .filter((row) => row.event_type === "trial_complete")
    .map((row) => {
      const run = runMetadata.get(row.run_id);
      return {
        run_id: row.run_id,
        sequence: row.sequence,
        trial_id: row.trial_id,
        client_time_ms: row.client_time_ms,
        server_time: row.server_time,
        study_type: run?.study_type ?? null,
        protocol_version: run?.protocol_version ?? null,
        schema_version: run?.schema_version ?? null,
        schedule_hash: run?.schedule_hash ?? null,
        outcome_bank_version: run?.outcome_bank_version ?? null,
        host: run?.host ?? "portal",
        host_session_id: run?.host_session_id ?? null,
        deployment_id: run?.deployment_id ?? null,
        client_version: run?.client_version ?? null,
        run_status: run?.status ?? null,
        run_started_at: run?.started_at ?? null,
        run_completed_at: run?.completed_at ?? null,
        participant_sex: run?.participant_sex ?? null,
        counterbalance_group: run?.counterbalance_group ?? null,
        recruitment_source: run?.recruitment_source ?? "manual",
        prolific_pid: run?.prolific_pid ?? null,
        prolific_study_id: run?.prolific_study_id ?? null,
        prolific_session_id: run?.prolific_session_id ?? null,
        gender_identity: run?.gender_identity ?? null,
        face_set_preference: run?.face_set_preference ?? null,
        ...(row.payload as Record<string, unknown>),
      };
    });
  const containsProlificLinkage = runs.rows.some((run) => run.recruitment_source === "prolific");
  return {
    schemaVersion: DATA_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    directLinkageExcluded: !containsProlificLinkage,
    containsProlificLinkage,
    runs: runs.rows,
    events: events.rows,
    participantEvents: participantEvents.rows,
    workflowSteps: workflowSteps.rows,
    trialRows,
  };
}

async function processFirebaseExports() {
  if (!process.env.FIREBASE_STORAGE_BUCKET) return;
  const pending = await db.query(
    `WITH candidates AS (
       SELECT run_id FROM firebase_exports
       WHERE status IN ('pending', 'failed')
          OR (status = 'uploading' AND updated_at < now() - interval '2 minutes')
       ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 10
     )
     UPDATE firebase_exports e SET status = 'uploading', attempts = attempts + 1,
       last_error = NULL, updated_at = now()
     FROM candidates c WHERE e.run_id = c.run_id
     RETURNING e.run_id`,
  );
  for (const row of pending.rows) {
    const runId = row.run_id as string;
    try {
      const data = await researchExportForRun(runId);
      const objects = await uploadResearchArchive(runId, data);
      if (!objects) continue;
      await db.query(
        `UPDATE firebase_exports SET status = 'uploaded', json_object = $2, tsv_object = $3,
           uploaded_at = now(), updated_at = now() WHERE run_id = $1`,
        [runId, objects.jsonObject, objects.tsvObject],
      );
    } catch (error) {
      await db.query(
        `UPDATE firebase_exports SET status = 'failed', last_error = $2, updated_at = now()
         WHERE run_id = $1`,
        [runId, (error instanceof Error ? error.message : String(error)).slice(0, 1000)],
      );
      app.log.error({ err: error, runId }, "Firebase research export upload failed");
    }
  }
}

async function researchExportForRun(runId: string) {
  const run = await db.query("SELECT access_grant_id FROM study_runs WHERE id = $1", [runId]);
  if (!run.rowCount) throw new Error("Run not found for export.");
  return researchExport(run.rows[0].access_grant_id as string);
}

app.get("/api/admin/export", async (request, reply) => {
  const actor = await requireAdmin(request, reply);
  if (!actor) return;
  const data = await researchExport();
  await audit(actor, "data.export", {
    scope: "all",
    runs: data.runs.length,
    events: data.events.length,
  });
  return data;
});

app.get<{ Params: { grantId: string } }>(
  "/api/admin/export/:grantId",
  async (request, reply) => {
    const actor = await requireAdmin(request, reply);
    if (!actor) return;
    const parsed = z.string().uuid().safeParse(request.params.grantId);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid grant ID" });
    const data = await researchExport(parsed.data);
    await audit(actor, "data.export", {
      scope: "grant",
      grantId: parsed.data,
      runs: data.runs.length,
      events: data.events.length,
    });
    return data;
  },
);

app.get<{ Params: { grantId: string }; Querystring: { format?: string } }>(
  "/api/admin/export/:grantId/file",
  async (request, reply) => {
    const actor = await requireAdmin(request, reply);
    if (!actor) return;
    const grantId = z.string().uuid().safeParse(request.params.grantId);
    const format = z.enum(["json", "tsv"]).safeParse(request.query.format);
    if (!grantId.success || !format.success)
      return reply.code(400).send({ error: "Invalid export request." });
    const archive = await db.query(
      `SELECT e.json_object, e.tsv_object, e.status, r.id AS run_id
       FROM study_runs r LEFT JOIN firebase_exports e ON e.run_id = r.id
       WHERE r.access_grant_id = $1 ORDER BY r.created_at DESC LIMIT 1`,
      [grantId.data],
    );
    if (!archive.rowCount) return reply.code(404).send({ error: "No run found for this participant." });
    const object = format.data === "json" ? archive.rows[0].json_object : archive.rows[0].tsv_object;
    let contents = object ? await downloadResearchArchive(object) : null;
    if (!contents) {
      const data = await researchExport(grantId.data);
      contents = Buffer.from(format.data === "json" ? JSON.stringify(data, null, 2) : trialRowsTsv(data));
    }
    await audit(actor, "data.export.file", {
      scope: "grant", grantId: grantId.data, format: format.data,
      source: object && archive.rows[0].status === "uploaded" ? "firebase-storage" : "postgres-generated",
    });
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Type", format.data === "json" ? "application/json; charset=utf-8" : "text/tab-separated-values; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename=participant-${archive.rows[0].run_id}.${format.data}`);
    return reply.send(contents);
  },
);

async function audit(actor: string, action: string, detail: unknown) {
  await db.query(
    "INSERT INTO admin_audit(actor, action, detail) VALUES ($1,$2,$3)",
    [actor, action, detail],
  );
}

function sanitizeRun(row: any, studyType: string) {
  return {
    id: row.id,
    studyType,
    recruitmentSource: row.recruitment_source ?? "manual",
    workflowDefinitionId: row.workflow_definition_id ?? null,
    protocolVersion: row.protocol_version,
    schemaVersion: row.schema_version,
    scheduleHash: row.schedule_hash,
    outcomeBankVersion: row.outcome_bank_version,
    schedule: row.schedule,
    status: row.status,
  };
}

if (isProduction) {
  await app.register(fastifyStatic, {
    root: path.resolve(
      process.env.STATIC_ROOT ?? path.join(process.cwd(), "dist"),
    ),
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith("/api/"))
      return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}

if (process.env.FIREBASE_STORAGE_BUCKET) {
  void processFirebaseExports();
  const archiveRetryTimer = setInterval(() => void processFirebaseExports(), 30_000);
  archiveRetryTimer.unref();
}

const port = Number(process.env.PORT ?? 3001);
await app.listen({ host: process.env.HOST ?? "0.0.0.0", port });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}
