import assert from "node:assert/strict";
import test from "node:test";
import { createFirestore } from "../server/firestore.js";

test("a demo project fails closed unless the Firestore emulator is configured", () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    project: process.env.FIREBASE_PROJECT_ID,
    emulator: process.env.FIRESTORE_EMULATOR_HOST,
  };
  try {
    process.env.NODE_ENV = "development";
    process.env.FIREBASE_PROJECT_ID = "demo-trust-gamev1";
    delete process.env.FIRESTORE_EMULATOR_HOST;
    assert.throws(() => createFirestore(), /requires FIRESTORE_EMULATOR_HOST/);
  } finally {
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.project === undefined) delete process.env.FIREBASE_PROJECT_ID; else process.env.FIREBASE_PROJECT_ID = previous.project;
    if (previous.emulator === undefined) delete process.env.FIRESTORE_EMULATOR_HOST; else process.env.FIRESTORE_EMULATOR_HOST = previous.emulator;
  }
});

test("production refuses to run against the Firestore emulator", () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    project: process.env.FIREBASE_PROJECT_ID,
    emulator: process.env.FIRESTORE_EMULATOR_HOST,
  };
  try {
    process.env.NODE_ENV = "production";
    process.env.FIREBASE_PROJECT_ID = "trust-gamev1";
    process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
    assert.throws(() => createFirestore(), /must not connect to the Firestore Emulator/);
  } finally {
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.project === undefined) delete process.env.FIREBASE_PROJECT_ID; else process.env.FIREBASE_PROJECT_ID = previous.project;
    if (previous.emulator === undefined) delete process.env.FIRESTORE_EMULATOR_HOST; else process.env.FIRESTORE_EMULATOR_HOST = previous.emulator;
  }
});
