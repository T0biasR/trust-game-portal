import type { QualityEvent, RunLogger, RunPayload } from "./types";
import { downloadText, toCsv } from "./csv";

function hasJatos() {
  return typeof jatos !== "undefined" && !!jatos;
}

export function createLogger(taskName: string, runKey: string, clockNow: () => number): RunLogger {
  const quality: QualityEvent[] = [];
  const storageKey = `online-task:${runKey}`;

  const submit = async (payload: RunPayload, final: boolean) => {
    const json = JSON.stringify(payload);
    localStorage.setItem(storageKey, json);
    if (hasJatos()) {
      await new Promise<void>((resolve) => {
        jatos!.submitResultData(json, resolve, resolve);
      });
      if (final) {
        try {
          jatos!.endStudy(json);
        } catch {
          // JATOS can be absent or reject duplicate finish calls in preview.
        }
      }
    }
  };

  return {
    quality,
    mark(type, detail) {
      quality.push({ t: clockNow(), type, detail });
    },
    async checkpoint(partial) {
      await submit({
        session: partial.session ?? {},
        schedule: partial.schedule ?? null,
        trials: partial.trials ?? [],
        traces: partial.traces,
        events: partial.events,
        blocks: partial.blocks,
        stateLog: partial.stateLog,
        quality,
      }, false);
    },
    async finish(payload) {
      payload.quality = quality;
      await submit(payload, true);
      const prefix = `${taskName}_${runKey}`;
      downloadText(`${prefix}.json`, JSON.stringify(payload, null, 2), "application/json");
      if (payload.trials.length) downloadText(`${prefix}_trials.csv`, toCsv(payload.trials), "text/csv");
      if (payload.traces?.length) downloadText(`${prefix}_traces.csv`, toCsv(payload.traces), "text/csv");
      if (payload.events?.length) downloadText(`${prefix}_events.csv`, toCsv(payload.events), "text/csv");
      if (payload.blocks?.length) downloadText(`${prefix}_blocks.csv`, toCsv(payload.blocks), "text/csv");
      if (payload.stateLog?.length) downloadText(`${prefix}_statelog.csv`, toCsv(payload.stateLog), "text/csv");
    },
  };
}
