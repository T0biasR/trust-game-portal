import test from "node:test";
import assert from "node:assert/strict";
import { validateWorkflowSteps, WORKFLOW_MODULES } from "../src/shared/workflow.js";

test("workflow registry exposes Trust Game but keeps unvalidated tasks disabled", () => {
  assert.equal(WORKFLOW_MODULES.find((module) => module.id === "trust-game")?.enabled, true);
  assert.equal(WORKFLOW_MODULES.find((module) => module.id === "hariri-face")?.enabled, false);
  assert.equal(WORKFLOW_MODULES.find((module) => module.id === "mausland")?.enabled, false);
});

test("workflow validation preserves module order and required flags", () => {
  const steps = [
    { id: "questionnaire-1", moduleId: "questionnaire:demographics", required: false },
    { id: "trust-1", moduleId: "trust-game", required: true },
  ];
  // The questionnaire registry is intentionally empty until an instrument is reviewed.
  assert.deepEqual(validateWorkflowSteps(steps), {
    ok: false,
    error: "Unknown workflow module: questionnaire:demographics.",
  });
  const valid = validateWorkflowSteps([{ id: "trust-1", moduleId: "trust-game", required: true }]);
  assert.deepEqual(valid, { ok: true, steps: [{ id: "trust-1", moduleId: "trust-game", required: true, moduleVersion: WORKFLOW_MODULES.find((module) => module.id === "trust-game")?.version }] });
});

test("workflow rejects duplicate step ids, disabled tasks and repeated Trust tasks", () => {
  assert.equal(validateWorkflowSteps([
    { id: "a", moduleId: "trust-game", required: true },
    { id: "a", moduleId: "trust-game", required: true },
  ]).ok, false);
  assert.equal(validateWorkflowSteps([{ id: "face", moduleId: "hariri-face", required: true }]).ok, false);
  assert.equal(validateWorkflowSteps([
    { id: "trust-a", moduleId: "trust-game", required: true },
    { id: "trust-b", moduleId: "trust-game", required: true },
  ]).ok, false);
  assert.equal(validateWorkflowSteps([
    { id: "trust-old", moduleId: "trust-game", required: true, moduleVersion: "old-protocol" },
  ]).ok, false);
});
