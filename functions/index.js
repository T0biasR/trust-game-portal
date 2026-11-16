import { onRequest } from "firebase-functions/v2/https";
import { defineBoolean, defineSecret, defineString } from "firebase-functions/params";

const codePepper = defineSecret("CODE_PEPPER");
const oidcProxySecret = defineSecret("OIDC_PROXY_SECRET");
const projectId = defineString("STUDY_FIREBASE_PROJECT_ID", { default: "trust-gamev1" });
const allowedOrigins = defineString("STUDY_ALLOWED_ORIGINS");
const consentReleased = defineBoolean("CONSENT_RELEASED", { default: false });
const researcherEmails = defineString("RESEARCHER_ACCOUNT_EMAILS");
const runtimeServiceAccount = defineString("FUNCTION_SERVICE_ACCOUNT");

export const portalApi = onRequest({
  region: "europe-west10",
  serviceAccount: runtimeServiceAccount,
  memory: "512MiB",
  timeoutSeconds: 60,
  maxInstances: 10,
  secrets: [codePepper, oidcProxySecret],
}, async (req, res) => {
  process.env.NODE_ENV = "production";
  process.env.FIREBASE_FUNCTIONS_MODE = "true";
  process.env.FIREBASE_PROJECT_ID = projectId.value();
  process.env.STUDY_ALLOWED_ORIGINS = allowedOrigins.value();
  process.env.RESEARCHER_ACCOUNT_EMAILS = researcherEmails.value();
  process.env.REQUIRE_APP_CHECK = process.env.FUNCTIONS_EMULATOR === "true" ? "false" : "true";
  process.env.CODE_PEPPER = codePepper.value();
  process.env.OIDC_PROXY_SECRET = oidcProxySecret.value();
  process.env.CONSENT_RELEASED = consentReleased.value() ? "true" : "false";

  // The same Fastify API handles session logic, but its listener and static
  // file server are disabled in function mode. The browser never gets secrets.
  const { app } = await import("./runtime/server-dist/server/firestoreIndex.js");
  await app.ready();
  // Firebase's HTTP framework has already consumed/parses the body stream.
  // Re-inject its parsed body so Fastify's JSON parser does not wait on an
  // exhausted IncomingMessage stream (GET health checks alone would mask this).
  const headers = { ...req.headers };
  delete headers["content-length"];
  delete headers["transfer-encoding"];
  delete headers.connection;
  delete headers.host;
  const payload = req.body === undefined
    ? undefined
    : typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const result = await app.inject({
    method: req.method,
    url: req.originalUrl || req.url,
    headers,
    ...(payload === undefined ? {} : { payload }),
    remoteAddress: req.ip,
  });
  res.statusCode = result.statusCode;
  for (const [name, value] of Object.entries(result.headers)) {
    if (value !== undefined) res.setHeader(name, value);
  }
  res.end(result.rawPayload);
});
