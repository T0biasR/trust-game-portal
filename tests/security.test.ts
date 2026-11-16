import assert from "node:assert/strict";
import test from "node:test";
import { adminIdentity, newCode, normalizeCode } from "../server/security.js";

test("access codes have a stable copy-safe 96-bit format", () => {
  const codes = new Set(Array.from({ length: 10_000 }, () => newCode()));
  assert.equal(codes.size, 10_000);
  for (const code of codes) {
    assert.match(code, /^[A-F0-9]{6}(?:-[A-F0-9]{6}){3}$/);
    assert.equal(normalizeCode(code), code.replaceAll("-", ""));
  }
});

test("institutional proxy identity is rejected unless a configured secret matches", () => {
  const priorSecret = process.env.OIDC_PROXY_SECRET;
  const priorMode = process.env.NODE_ENV;
  const priorToken = process.env.DEV_ADMIN_TOKEN;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.DEV_ADMIN_TOKEN;
    delete process.env.OIDC_PROXY_SECRET;
    const forged = { headers: { "x-forwarded-user": "researcher", "x-research-proxy-secret": undefined } } as any;
    assert.equal(adminIdentity(forged), null);

    process.env.OIDC_PROXY_SECRET = "x".repeat(40);
    forged.headers["x-research-proxy-secret"] = "x".repeat(40);
    assert.equal(adminIdentity(forged), "researcher");
    forged.headers["x-research-proxy-secret"] = "wrong";
    assert.equal(adminIdentity(forged), null);
  } finally {
    if (priorSecret === undefined) delete process.env.OIDC_PROXY_SECRET;
    else process.env.OIDC_PROXY_SECRET = priorSecret;
    if (priorMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorMode;
    if (priorToken === undefined) delete process.env.DEV_ADMIN_TOKEN;
    else process.env.DEV_ADMIN_TOKEN = priorToken;
  }
});
