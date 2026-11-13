import { useEffect, useMemo, useState } from "react";
import { api, type RunDto } from "../api";
import { QUESTIONNAIRES, type QuestionnaireDefinition, type QuestionnaireQuestion } from "../shared/questionnaires";
import { TrustStudy } from "./TrustStudy";

type Workflow = {
  id: string;
  name: string;
  version: number;
  contentHash: string;
  steps: Array<{ id: string; moduleId: string; required: boolean }>;
  progress?: Array<{ stepId: string; moduleId: string; status: string }>;
};

export function WorkflowRunner({ run, workflow, onDone }: {
  run: RunDto;
  workflow: Workflow;
  onDone: (completionCode: string, redirectUrl: string | null) => void;
}) {
  const alreadyCompleted = useMemo(() => new Set(
    (workflow.progress ?? []).filter((item) => item.status === "completed").map((item) => item.stepId),
  ), [workflow.progress]);
  const [completed, setCompleted] = useState(alreadyCompleted);
  const firstIncomplete = workflow.steps.findIndex((step) => !alreadyCompleted.has(step.id));
  const [index, setIndex] = useState(firstIncomplete < 0 ? workflow.steps.length : firstIncomplete);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const step = workflow.steps[index];

  const submitCompletion = async (doneSteps = completed) => {
    setBusy(true);
    setError("");
    try {
      const result = await api.complete(run.id, {
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        workflowHash: workflow.contentHash,
        completedSteps: [...doneSteps],
      });
      onDone(result.completionCode, result.completionRedirectUrl ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!step || completed.has(step.id)) return;
    void api.workflowStep(run.id, step.id, "started").catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [run.id, step?.id]);

  const finishStep = async (stepId: string) => {
    const nextCompleted = new Set(completed);
    nextCompleted.add(stepId);
    setCompleted(nextCompleted);
    const nextIndex = workflow.steps.findIndex((candidate, candidateIndex) => candidateIndex > index && !nextCompleted.has(candidate.id));
    if (nextIndex >= 0) {
      setIndex(nextIndex);
      return;
    }
    if (workflow.steps.some((candidate) => candidate.required && !nextCompleted.has(candidate.id))) {
      setError("Ein erforderlicher Schritt wurde noch nicht abgeschlossen.");
      return;
    }
    await submitCompletion(nextCompleted);
  };

  if (!step) return <main className="centered"><section className="card">
    <span className="eyebrow">Daten werden geprüft</span>
    <h1>{busy ? "Einen Moment bitte …" : "Ablauf vollständig"}</h1>
    <p>Der Server prüft die übermittelten Schritte und erstellt Ihren Abschluss.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <button className="primary" disabled={busy} onClick={() => void submitCompletion()}>{busy ? "Wird geprüft …" : "Abschluss erneut prüfen"}</button>
  </section></main>;

  if (step.moduleId === "trust-game") return <TrustStudy
    run={run}
    deferCompletion
    workflowStepId={step.id}
    onDone={() => void finishStep(step.id)}
  />;

  if (step.moduleId.startsWith("questionnaire:")) {
    const instrument = QUESTIONNAIRES.find((item) => item.id === step.moduleId);
    if (instrument) return <QuestionnaireStep
      definition={instrument}
      busy={busy}
      error={error}
      onSubmit={async (responses) => {
        await api.workflowStep(run.id, step.id, "completed", { instrumentVersion: instrument.version, responses });
        await finishStep(step.id);
      }}
    />;
  }

  return <main className="centered"><section className="card">
    <span className="eyebrow">Nicht verfügbar</span>
    <h1>Dieser Schritt ist noch nicht freigegeben.</h1>
    <p>Bitte kontaktieren Sie das Studienteam. Ihre bisherigen Angaben bleiben erhalten.</p>
    <p className="fine-print">Schritt: {step.moduleId}</p>
  </section></main>;
}

function QuestionnaireStep({ definition, busy, error, onSubmit }: {
  definition: QuestionnaireDefinition;
  busy: boolean;
  error: string;
  onSubmit: (responses: Record<string, unknown>) => Promise<void>;
}) {
  const [responses, setResponses] = useState<Record<string, unknown>>({});
  const [localError, setLocalError] = useState("");
  const update = (question: QuestionnaireQuestion, value: unknown) =>
    setResponses((current) => ({ ...current, [question.id]: value }));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const missing = definition.questions.find((question) => question.required && (
      responses[question.id] === undefined || responses[question.id] === "" ||
      (Array.isArray(responses[question.id]) && (responses[question.id] as unknown[]).length === 0)
    ));
    if (missing) {
      setLocalError("Bitte beantworten Sie alle erforderlichen Fragen.");
      document.getElementById(`q-${missing.id}`)?.focus();
      return;
    }
    setLocalError("");
    try { await onSubmit(responses); } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return <main className="centered"><form className="card consent questionnaire" onSubmit={(event) => void submit(event)}>
    <span className="eyebrow">Fragebogen · Version {definition.version}</span>
    <h1>{definition.title}</h1>
    {definition.instructions && <p>{definition.instructions}</p>}
    {definition.questions.map((question) => <Question key={question.id} question={question} value={responses[question.id]} onChange={(value) => update(question, value)} />)}
    <button className="primary" disabled={busy}>{busy ? "Wird gespeichert …" : "Weiter"}</button>
    {(localError || error) && <p className="error" role="alert">{localError || error}</p>}
  </form></main>;
}

function Question({ question, value, onChange }: {
  question: QuestionnaireQuestion;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const required = question.required ? " *" : "";
  if (question.type === "single_choice") return <fieldset className="field" id={`q-${question.id}`}>
    <legend>{question.prompt}{required}</legend>
    {(question.options ?? []).map((option) => <label className="check" key={option.value}>
      <input type="radio" name={question.id} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />{option.label}
    </label>)}
  </fieldset>;
  if (question.type === "multiple_choice") return <fieldset className="field" id={`q-${question.id}`}>
    <legend>{question.prompt}{required}</legend>
    {(question.options ?? []).map((option) => {
      const selected = Array.isArray(value) ? value as string[] : [];
      return <label className="check" key={option.value}><input type="checkbox" checked={selected.includes(option.value)} onChange={(event) => onChange(event.target.checked ? [...selected, option.value] : selected.filter((item) => item !== option.value))} />{option.label}</label>;
    })}
  </fieldset>;
  if (question.type === "likert") return <label className="field" id={`q-${question.id}`}>
    {question.prompt}{required}
    <input type="range" min={question.min ?? 1} max={question.max ?? 5} step="1" value={typeof value === "number" ? value : (question.min ?? 1)} onChange={(event) => onChange(Number(event.target.value))} />
    <span className="scale-labels"><span>{question.minLabel ?? question.min ?? 1}</span><span>{question.maxLabel ?? question.max ?? 5}</span></span>
  </label>;
  const type = question.type === "number" ? "number" : "text";
  return <label className="field" id={`q-${question.id}`}>
    {question.prompt}{required}
    <input type={type} min={question.min} max={question.max} value={typeof value === "string" || typeof value === "number" ? value : ""} onChange={(event) => onChange(type === "number" ? (event.target.value === "" ? "" : Number(event.target.value)) : event.target.value)} />
  </label>;
}
