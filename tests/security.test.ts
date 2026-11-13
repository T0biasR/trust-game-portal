import assert from "node:assert/strict";
import test from "node:test";
import { newCode, normalizeCode } from "../server/security.js";

test("access codes have a stable copy-safe 96-bit format", () => {
  const codes = new Set(Array.from({ length: 10_000 }, () => newCode()));
  assert.equal(codes.size, 10_000);
  for (const code of codes) {
    assert.match(code, /^[A-F0-9]{6}(?:-[A-F0-9]{6}){3}$/);
    assert.equal(normalizeCode(code), code.replaceAll("-", ""));
  }
});
