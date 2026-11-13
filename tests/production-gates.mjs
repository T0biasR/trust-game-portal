const base = process.env.API_BASE ?? "http://127.0.0.1:3001";
const proxySecret = process.env.OIDC_PROXY_SECRET;
if (!proxySecret) throw new Error("OIDC_PROXY_SECRET is required");
let cookie = "";

async function request(path, body, headers = {}) {
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
  return { response, body: await response.json().catch(() => ({})) };
}

const page = await fetch(`${base}/`);
if (!page.headers.get("strict-transport-security"))
  throw new Error("HSTS is missing");
if (
  !page.headers
    .get("content-security-policy")
    ?.includes("frame-ancestors 'none'")
)
  throw new Error("CSP is missing");

const adminHeaders = {
  "X-Forwarded-User": "production-test",
  "X-Research-Proxy-Secret": proxySecret,
};
const generated = await request(
  "/api/admin/codes",
  { count: 1, studyType: "investor", validDays: 1 },
  adminHeaders,
);
if (!generated.response.ok)
  throw new Error(
    `OIDC proxy authentication failed: ${JSON.stringify(generated.body)}`,
  );
await request("/api/auth/code", { code: generated.body.codes[0] });
await request("/api/participant/consent", {
  accepted: true,
  documentVersion: "consent-de-v1",
});
const run = await request("/api/runs", {});
if (
  run.response.status !== 503 ||
  !String(run.body.error).includes("Ethikfreigabe")
) {
  throw new Error(
    `Placeholder consent release gate failed: ${run.response.status} ${JSON.stringify(run.body)}`,
  );
}

console.log(
  JSON.stringify(
    { hsts: true, csp: true, oidcProxy: true, placeholderConsentBlocked: true },
    null,
    2,
  ),
);
