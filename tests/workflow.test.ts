import test from "node:test";
import assert from "node:assert/strict";
import { assignWorkflowOrder, validateWorkflowSteps, WORKFLOW_MODULES, type WorkflowStep } from "../src/shared/workflow.js";

test("workflow registry exposes Trust Game but keeps unvalidated tasks disabled", () => {
  assert.equal(WORKFLOW_MODULES.find((module) => module.id === "trust-game")?.enabled, true);
  assert.equal(WORKFLOW_MODULES.find((module) => module.id === "hariri-face")?.enabled, false);
  assert.equal(WORKFLOW_MODULES.find((module) => module.id === "hariri-binary")?.enabled, false);
  assert.equal(WORKFLOW_MODULES.find((module) => module.id === "hariri-slider")?.enabled, false);
  assert.equal(WORKFLOW_MODULES.find((module) => module.id === "mausland")?.enabled, false);
});

test("participant task randomization changes only task slots and is reproducible with a supplied RNG", () => {
  const steps: WorkflowStep[] = [
    { id: "pre", moduleId: "questionnaire:pre", required: true, moduleVersion: "1" },
    { id: "trust", moduleId: "trust-game", required: true, moduleVersion: "1" },
    { id: "binary", moduleId: "hariri-binary", required: true, moduleVersion: "1" },
    { id: "post", moduleId: "questionnaire:post", required: true, moduleVersion: "1" },
    { id: "slider", moduleId: "hariri-slider", required: true, moduleVersion: "1" },
  ];
  const values = [0, 0];
  const randomized = assignWorkflowOrder(steps, true, () => values.shift() ?? 0);
  assert.deepEqual(randomized.map((step) => step.id), ["pre", "binary", "slider", "post", "trust"]);
  assert.deepEqual(assignWorkflowOrder(steps, false).map((step) => step.id), steps.map((step) => step.id));
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
