import { QUESTIONNAIRES } from "./questionnaires.js";
import { PROTOCOL_VERSION } from "./protocol.js";

export type WorkflowModuleId =
  | "trust-game"
  | "hariri-binary"
  | "hariri-slider"
  | "hariri-face"
  | "mausland"
  | `questionnaire:${string}`;

export type WorkflowStep = {
  id: string;
  moduleId: WorkflowModuleId;
  required: boolean;
  moduleVersion: string;
};

export type WorkflowDefinition = {
  id: string;
  name: string;
  version: number;
  status: "draft" | "published" | "retired";
  steps: WorkflowStep[];
  randomizeTaskOrder: boolean;
  contentHash: string;
};

export type WorkflowModule = {
  id: WorkflowModuleId;
  title: string;
  kind: "task" | "questionnaire";
  enabled: boolean;
  description: string;
  version: string;
};

// Keep only validated production modules selectable. Additional task modules
// are registered as disabled until their server-side logging and completion
// criteria have passed the same acceptance checks as the Trust Game.
export const WORKFLOW_MODULES: WorkflowModule[] = [
  {
    id: "trust-game",
    title: "Trust Game",
    kind: "task",
    enabled: true,
    description: "Current online task implementation; migration to the selected Version 05 source is still pending.",
    version: PROTOCOL_VERSION,
  },
  {
    id: "hariri-binary",
    title: "Hariri Binary",
    kind: "task",
    enabled: false,
    description: "DeCoDe26 source identified; browser implementation, stimuli package and data validation are pending.",
    version: "decode26-binary-pending",
  },
  {
    id: "hariri-slider",
    title: "Hariri Slider",
    kind: "task",
    enabled: false,
    description: "DeCoDe26 source identified; browser implementation, stimuli package and data validation are pending.",
    version: "decode26-slider-pending",
  },
  {
    id: "hariri-face",
    title: "Hariri Face Task (legacy)",
    kind: "task",
    enabled: false,
    description: "Not yet cleared for workflow-based production collection.",
    version: "not-released",
  },
  {
    id: "mausland",
    title: "Mausland Task",
    kind: "task",
    enabled: false,
    description: "Not yet cleared for workflow-based production collection.",
    version: "not-released",
  },
  ...QUESTIONNAIRES.map((questionnaire) => ({
    id: questionnaire.id as WorkflowModuleId,
    title: questionnaire.title,
    kind: "questionnaire" as const,
    enabled: true,
    description: `Reviewed questionnaire version ${questionnaire.version}.`,
    version: questionnaire.version,
  })),
];

export function validateWorkflowSteps(value: unknown):
  | { ok: true; steps: WorkflowStep[] }
  | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20)
    return { ok: false, error: "A workflow must contain 1–20 steps." };
  const ids = new Set<string>();
  const steps: WorkflowStep[] = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object")
      return { ok: false, error: `Step ${index + 1} is invalid.` };
    const step = item as Record<string, unknown>;
    if (
      typeof step.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(step.id) ||
      typeof step.moduleId !== "string" ||
      typeof step.required !== "boolean"
    ) return { ok: false, error: `Step ${index + 1} is invalid.` };
    if (ids.has(step.id))
      return { ok: false, error: `Duplicate step id: ${step.id}.` };
    ids.add(step.id);
    const module = WORKFLOW_MODULES.find((candidate) => candidate.id === step.moduleId);
    if (!module)
      return { ok: false, error: `Unknown workflow module: ${step.moduleId}.` };
    if (!module.enabled)
      return { ok: false, error: `Workflow module is not production-enabled: ${step.moduleId}.` };
    if (step.moduleVersion !== undefined && step.moduleVersion !== module.version)
      return { ok: false, error: `Workflow module version is no longer current: ${step.moduleId}.` };
    steps.push({ id: step.id, moduleId: module.id, required: step.required, moduleVersion: module.version });
  }
  if (steps.filter((step) => step.moduleId === "trust-game").length > 1)
    return { ok: false, error: "The current backend supports one Trust Game step per workflow." };
  return { ok: true, steps };
}

/** Randomize task steps once per participant while preserving questionnaire slots. */
export function assignWorkflowOrder(
  steps: WorkflowStep[],
  randomizeTaskOrder: boolean,
  random: () => number = Math.random,
): WorkflowStep[] {
  const assigned = steps.map((step) => ({ ...step }));
  if (!randomizeTaskOrder) return assigned;
  const taskPositions: number[] = [];
  const tasks: WorkflowStep[] = [];
  for (const [index, step] of assigned.entries()) {
    const module = WORKFLOW_MODULES.find((candidate) => candidate.id === step.moduleId);
    if (module?.kind === "task") {
      taskPositions.push(index);
      tasks.push(step);
    }
  }
  for (let index = tasks.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    [tasks[index], tasks[selected]] = [tasks[selected], tasks[index]];
  }
  taskPositions.forEach((position, index) => { assigned[position] = tasks[index]; });
  return assigned;
}
