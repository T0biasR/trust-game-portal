import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";

export function digest(value: string) {
  const pepper = process.env.CODE_PEPPER ?? "development-only-change-me";
  return crypto.createHmac("sha256", pepper).update(value).digest("hex");
}

export function normalizeCode(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function newCode() {
  // 96 bits of entropy, rendered with copy-safe hexadecimal characters only.
  const raw = crypto.randomBytes(12).toString("hex").toUpperCase();
  return `${raw.slice(0, 6)}-${raw.slice(6, 12)}-${raw.slice(12, 18)}-${raw.slice(18, 24)}`;
}

export function newParticipantCode(
  sex: "male" | "female",
  counterbalanceGroup: "CB1" | "CB2" | "CB3",
) {
  const sexLetter = sex === "male" ? "M" : "W";
  const raw = crypto.randomBytes(9).toString("hex").toUpperCase();
  return `TG-${sexLetter}-${counterbalanceGroup}-${raw.slice(0, 6)}-${raw.slice(6, 12)}-${raw.slice(12, 18)}`;
}

export function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function stableJsonHash(value: unknown) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function checkRateLimit(key: string, max = 10, windowMs = 60_000) {
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= max;
}

export function adminIdentity(request: FastifyRequest) {
  const proxyUser = request.headers["x-forwarded-user"];
  const proxySecret = request.headers["x-research-proxy-secret"];
  if (
    typeof proxyUser === "string" &&
    proxySecret === process.env.OIDC_PROXY_SECRET
  )
    return proxyUser;
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (
    process.env.NODE_ENV !== "production" &&
    bearer &&
    bearer === process.env.DEV_ADMIN_TOKEN
  )
    return "development-admin";
  return null;
}
