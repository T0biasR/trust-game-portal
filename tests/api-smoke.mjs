import { randomUUID } from "node:crypto";

const base = process.env.API_BASE ?? "http://127.0.0.1:3001";
const adminHeaders = {
  Authorization: `Bearer ${process.env.DEV_ADMIN_TOKEN ?? "local-admin"}`,
};
let cookie = "";

async function raw(path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const value = await response.json();
  return { response, value };
}

async function call(path, body, headers = {}) {
  const result = await raw(path, body, headers);
  if (!result.response.ok)
    throw new Error(
      `${path}: ${result.response.status} ${JSON.stringify(result.value)}`,
    );
  return result.value;
}

function event(sequence, eventType, payload, trialId = null) {
  return {
    sequence,
    eventId: randomUUID(),
    eventType,
    trialId,
    clientTimeMs: sequence * 10,
    payload,
  };
}

async function newParticipant(studyType) {
  const generated = await call(
    "/api/admin/codes",
    { count: 1, studyType, validDays: 1 },
    adminHeaders,
  );
  await call("/api/auth/code", { code: generated.codes[0] });
  await call("/api/participant/consent", {
    accepted: true,
    documentVersion: "consent-de-v1",
  });
  const run = await call("/api/runs", {});
  await call(`/api/runs/${run.id}/start`, {});
  return run;
}

const health = await call("/api/health");
if (!health.ok) throw new Error("Health check failed");

const run = await newParticipant("investor");
if (
  run.schedule.trustTrials.length !== 72 ||
  run.schedule.riskTrials.length !== 0
)
  throw new Error("Invalid server schedule");
const premature = await raw(`/api/runs/${run.id}/complete`, {
  summary: { smoke: true },
});
if (premature.response.status !== 409)
  throw new Error("Incomplete run was accepted");

const researchEvents = [];
let sequence = 0;
researchEvents.push(
  event(sequence++, "comprehension_attempt", { correct: true, attempt: 1 }),
);
researchEvents.push(event(sequence++, "seriousness_check", { serious: true }));
for (const spec of run.schedule.trustTrials) {
  const profile = spec.leftProfile ?? "neutral";
  const outcome = await call(`/api/runs/${run.id}/outcome`, {
    trialId: spec.trialId,
    profile,
    investment: 0.4,
    chosenSide: spec.leftProfile ? "left" : undefined,
  });
  researchEvents.push(
    event(
      sequence++,
      "trial_complete",
      {
        domain: "trust",
        trial_id: spec.trialId,
        ordinal: spec.ordinal,
        block: spec.block,
        trial_kind: spec.kind,
        left_profile: spec.leftProfile,
        right_profile: spec.rightProfile,
        chosen_profile: profile,
        choice_key: spec.leftProfile ? "left" : null,
        investment: 0.4,
        returned: outcome.returned,
        invested: 0.4,
        omitted: false,
      },
      spec.trialId,
    ),
  );
}
for (let start = 0; start < researchEvents.length; start += 50) {
  const batch = researchEvents.slice(start, start + 50);
  await call(`/api/runs/${run.id}/events`, { events: batch });
  await call(`/api/runs/${run.id}/events`, { events: batch }); // idempotency
}
const completion = await call(`/api/runs/${run.id}/complete`, {
  summary: { smoke: true },
});
if (
  !completion.completionCode ||
  completion.bonusEur < 0 ||
  completion.bonusEur > 5
)
  throw new Error("Invalid investor completion");
const mutation = await raw(`/api/runs/${run.id}/events`, {
  events: [event(sequence, "late_mutation", {})],
});
if (mutation.response.status !== 409)
  throw new Error("Completed run remained mutable");

const trustee = await newParticipant("trustee");
const returns = Array.from({ length: 11 }, (_, investment) => investment);
const trusteeEvents = [
  event(0, "comprehension_attempt", { correct: true }),
  ...returns.map((returned, investment) =>
    event(
      investment + 1,
      "trustee_decision",
      { investment, tripled: investment * 3, returned, rt_ms: 1000 },
      `trustee-${investment}`,
    ),
  ),
];
await call(`/api/runs/${trustee.id}/events`, { events: trusteeEvents });
await call(`/api/runs/${trustee.id}/trustee-policy`, {
  returnsByInvestment: returns,
});
const trusteeCompletion = await call(`/api/runs/${trustee.id}/complete`, {
  summary: { smoke: true },
});
if (trusteeCompletion.bonusEur < 0 || trusteeCompletion.bonusEur > 5)
  throw new Error("Invalid trustee completion");

const policies = await call(
  "/api/admin/trustee-policies",
  undefined,
  adminHeaders,
);
const policy = policies.policies.find(
  (row) => row.returns_by_investment.join(",") === returns.join(","),
);
if (!policy || policy.quality_passed)
  throw new Error("Participant policy bypassed researcher review");
await call(
  `/api/admin/trustee-policies/${policy.id}/quality`,
  { passed: true },
  adminHeaders,
);
const grants = await call("/api/admin/codes", undefined, adminHeaders);
if (!grants.grants.length) throw new Error("Admin grant listing failed");

// End-to-end Prolific workflow path: external IDs, resumable bearer session,
// gender/face-set decision, MRI counterbalancing, server-verified task completion,
// archive downloads, and completion redirect.
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const prolificStudyId = `prolific_${suffix}`;
const prolificSessionId = `session_${suffix}`;
const prolificPid = randomUUID().replaceAll("-", "").slice(0, 24);
const draft = await call("/api/admin/workflows", {
  name: `Prolific Trust ${suffix}`,
  steps: [{ id: "trust-main", moduleId: "trust-game", required: true }],
}, adminHeaders);
const published = await call(`/api/admin/workflows/${draft.workflow.id}/publish`, {}, adminHeaders);
if (published.workflow.status !== "published") throw new Error("Workflow publish failed");
const prolificCompletionUrl = "https://app.prolific.com/submissions/complete?cc=ABC123";
await call("/api/admin/prolific-studies", {
  prolificStudyId,
  workflowDefinitionId: published.workflow.id,
  completionUrl: prolificCompletionUrl,
  active: true,
}, adminHeaders);

cookie = "";
const entry = await call("/api/prolific/entry", {
  prolificPid, studyId: prolificStudyId, sessionId: prolificSessionId,
});
const prolificHeaders = { Authorization: `Bearer ${entry.sessionToken}` };
await call("/api/participant/consent", { accepted: true, documentVersion: "consent-prolific-de-v1" }, prolificHeaders);
await call("/api/participant/face-set", { genderIdentity: "prefer_not_to_say", faceSetPreference: "random" }, prolificHeaders);
const prolificRun = await call("/api/runs", {}, prolificHeaders);
if (prolificRun.schedule.trustTrials.length !== 72 || !["CB1", "CB2", "CB3"].includes(prolificRun.schedule.cbGroup))
  throw new Error("Prolific MRI-matched Trust schedule or counterbalance is invalid");
await call(`/api/runs/${prolificRun.id}/start`, {}, prolificHeaders);
await call(`/api/runs/${prolificRun.id}/workflow-step`, { stepId: "trust-main", action: "started" }, prolificHeaders);
const prolificPremature = await raw(`/api/runs/${prolificRun.id}/complete`, { summary: { smoke: true } }, prolificHeaders);
if (prolificPremature.response.status !== 409) throw new Error("Incomplete Prolific workflow was accepted");
const prolificEvents = [
  event(0, "comprehension_attempt", { correct: true, attempt: 1 }),
  event(1, "seriousness_check", { serious: true }),
];
let prolificSequence = 2;
for (const spec of prolificRun.schedule.trustTrials) {
  const profile = spec.leftProfile ?? "neutral";
  const outcome = await call(`/api/runs/${prolificRun.id}/outcome`, {
    trialId: spec.trialId,
    profile,
    investment: 0.4,
    chosenSide: spec.leftProfile ? "left" : undefined,
  }, prolificHeaders);
  prolificEvents.push(event(prolificSequence++, "trial_complete", {
    domain: "trust", ordinal: spec.ordinal, block: spec.block,
    chosen_profile: profile, investment: 0.4, returned: outcome.returned,
    omitted: false,
  }, spec.trialId));
}
for (let start = 0; start < prolificEvents.length; start += 50)
  await call(`/api/runs/${prolificRun.id}/events`, { events: prolificEvents.slice(start, start + 50) }, prolificHeaders);
await call(`/api/runs/${prolificRun.id}/workflow-step`, { stepId: "trust-main", action: "completed" }, prolificHeaders);
const prolificCompletion = await call(`/api/runs/${prolificRun.id}/complete`, { summary: { smoke: true } }, prolificHeaders);
if (prolificCompletion.completionRedirectUrl !== prolificCompletionUrl)
  throw new Error("Prolific completion redirect did not match configured URL");
// The stable participant grant ID is not exposed by the participant entry API;
// resolve it through the authenticated administration listing for this smoke run.
const listedGrants = await call("/api/admin/codes", undefined, adminHeaders);
const prolificGrant = listedGrants.grants.find((grant) => grant.prolific_session_id === prolificSessionId);
if (!prolificGrant) throw new Error("Prolific grant was not available to the researcher");
const perParticipantJson = await raw(`/api/admin/export/${prolificGrant.id}/file?format=json`, undefined, adminHeaders);
const perParticipantTsv = await raw(`/api/admin/export/${prolificGrant.id}/file?format=tsv`, undefined, adminHeaders);
if (!perParticipantJson.response.ok || !perParticipantJson.response.headers.get("content-type")?.includes("application/json"))
  throw new Error("Per-participant JSON download failed");
if (!perParticipantTsv.response.ok || !perParticipantTsv.response.headers.get("content-type")?.includes("tab-separated-values"))
  throw new Error("Per-participant TSV download failed");

console.log(
  JSON.stringify(
    {
      health,
      investor: {
        runId: run.id,
        completionCode: completion.completionCode,
        bonusEur: completion.bonusEur,
      },
      trustee: {
        runId: trustee.id,
        completionCode: trusteeCompletion.completionCode,
        bonusEur: trusteeCompletion.bonusEur,
      },
      prolific: {
        runId: prolificRun.id,
        counterbalanceGroup: prolificRun.schedule.cbGroup,
        completionRedirect: prolificCompletion.completionRedirectUrl,
        separateJsonAndTsv: true,
      },
      idempotentEvents: researchEvents.length,
      researcherQualityApproval: true,
    },
    null,
    2,
  ),
);
