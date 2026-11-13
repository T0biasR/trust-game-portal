export type QuestionnaireQuestion = {
  id: string;
  prompt: string;
  type: "single_choice" | "multiple_choice" | "likert" | "text" | "number";
  required: boolean;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  minLabel?: string;
  maxLabel?: string;
};

export type QuestionnaireDefinition = {
  id: `questionnaire:${string}`;
  version: string;
  title: string;
  instructions?: string;
  questions: QuestionnaireQuestion[];
};

// Each study instrument is added here only after its exact wording, response
// options, scoring and ethics-approved version have been reviewed. The generic
// renderer can present these specifications without executing arbitrary code.
export const QUESTIONNAIRES: readonly QuestionnaireDefinition[] = [];

export function questionnaireById(id: string) {
  return QUESTIONNAIRES.find((item) => item.id === id) ?? null;
}

export function validateQuestionnaireResponses(
  questionnaireId: string,
  value: unknown,
): { ok: true } | { ok: false; error: string } {
  const instrument = questionnaireById(questionnaireId);
  if (!instrument) return { ok: false, error: "Questionnaire is not registered and reviewed." };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, error: "Questionnaire responses must be an object." };
  const responses = value as Record<string, unknown>;
  const allowed = new Set(instrument.questions.map((question) => question.id));
  if (Object.keys(responses).some((key) => !allowed.has(key)))
    return { ok: false, error: "Unexpected questionnaire response field." };
  for (const question of instrument.questions) {
    const answer = responses[question.id];
    if (answer === undefined || answer === "" || (Array.isArray(answer) && answer.length === 0)) {
      if (question.required) return { ok: false, error: `Required response missing: ${question.id}.` };
      continue;
    }
    if (question.type === "single_choice") {
      if (typeof answer !== "string" || !question.options?.some((option) => option.value === answer))
        return { ok: false, error: `Invalid choice response: ${question.id}.` };
    } else if (question.type === "multiple_choice") {
      if (!Array.isArray(answer) || answer.some((item) => typeof item !== "string" || !question.options?.some((option) => option.value === item)) || new Set(answer).size !== answer.length)
        return { ok: false, error: `Invalid multiple-choice response: ${question.id}.` };
    } else if (question.type === "likert" || question.type === "number") {
      const min = question.min ?? (question.type === "likert" ? 1 : undefined);
      const max = question.max ?? (question.type === "likert" ? 5 : undefined);
      if (typeof answer !== "number" || !Number.isFinite(answer) || (question.type === "likert" && !Number.isInteger(answer)) || (min !== undefined && answer < min) || (max !== undefined && answer > max))
        return { ok: false, error: `Invalid numeric response: ${question.id}.` };
    } else if (typeof answer !== "string" || answer.length > 10_000) {
      return { ok: false, error: `Invalid text response: ${question.id}.` };
    }
  }
  return { ok: true };
}
