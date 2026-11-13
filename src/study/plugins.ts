import {
  ParameterType,
  type JsPsych,
  type JsPsychPlugin,
  type TrialType,
} from "jspsych";
import type { RiskTrialSpec, TrustTrialSpec } from "../shared/protocol";

type Outcome = {
  policyId: string;
  invested: number;
  tripled: number;
  returned: number;
  payoff: number;
  net: number;
  outcomeType: "win" | "lose" | "break_even";
  condition: "reward" | "punishment" | "learning";
  probability: number;
  randomDraw: number | null;
};

const trustInfo = {
  name: "trust-investment",
  version: "1.0.0",
  parameters: {
    spec: { type: ParameterType.OBJECT, default: undefined },
    faceUrls: { type: ParameterType.OBJECT, default: undefined },
    stimulusUrls: { type: ParameterType.OBJECT, default: undefined },
    resolveOutcome: { type: ParameterType.FUNCTION, default: undefined },
  },
  data: {},
} as const;

export class TrustTrialPlugin implements JsPsychPlugin<typeof trustInfo> {
  static info = trustInfo;
  constructor(private jsPsych: JsPsych) {}

  async trial(display: HTMLElement, trial: TrialType<typeof trustInfo>) {
    const spec = trial.spec as unknown as TrustTrialSpec;
    const faceUrls = trial.faceUrls as Record<string, string>;
    const stimulusUrls = (trial.stimulusUrls ?? {}) as Record<string, string>;
    const resolve = trial.resolveOutcome as unknown as (
      trialId: string,
      profile: string,
      investment: number,
      chosenSide?: string,
    ) => Promise<Outcome>;
    const trialStart = performance.now();
    const transitions: Array<{ t: number; action: string; value?: number }> =
      [];
    display.innerHTML = `<div class="experiment-screen fixation-dot" aria-label="Fixation">•</div>`;
    await sleep(spec.fixationMs);

    let slider = 0;
    const sliderTrace: Array<{ t: number; value: number }> = [];
    let firstMoveRt: number | null = null;
    const responseStart = performance.now();
    const isLearning = spec.trialType === "learning_object";
    const leftUrl = isLearning
      ? stimulusUrls[spec.objectLeft ?? ""]
      : faceUrls[spec.leftProfile ?? ""];
    const rightUrl = isLearning
      ? stimulusUrls[spec.objectRight ?? ""]
      : faceUrls[spec.rightProfile ?? ""];
    display.innerHTML = trialHtml(spec, leftUrl, rightUrl, slider);
    const stopCountdown = startCircularTimer(display, 4000);
    const update = () => {
      const marker = display.querySelector(
        "[data-slider-marker]",
      ) as HTMLElement | null;
      const amount = display.querySelector(
        "[data-slider-value]",
      ) as HTMLElement | null;
      if (marker) marker.style.left = `${((slider + 1) / 2) * 100}%`;
      if (amount) amount.textContent = `${Math.abs(slider).toFixed(2)} EUR`;
    };
    const onKey = (key: string) => {
      if (!firstMoveRt && Math.abs(slider) < 0.01)
        firstMoveRt = performance.now() - responseStart;
      slider = Math.max(
        -1,
        Math.min(1, slider + (key === "ArrowLeft" ? -0.005 : 0.005)),
      );
      transitions.push({
        t: performance.now() - trialStart,
        action: key,
        value: slider,
      });
      update();
    };
    const traceTimer = window.setInterval(
      () =>
        sliderTrace.push({
          t: performance.now() - responseStart,
          value: slider,
        }),
      20,
    );
    // The response window is fixed: the current position is saved
    // automatically after four seconds.
    await waitForContinuousArrows(4000, onKey);
    stopCountdown();
    window.clearInterval(traceTimer);
    const chosenSide = slider < -0.01 ? "left" : slider > 0.01 ? "right" : null;
    const chosenProfile =
      (chosenSide === "left"
        ? spec.leftProfile
        : chosenSide === "right"
          ? spec.rightProfile
          : "neutral") ?? "neutral";
    const choiceOmitted = !chosenSide;
    const investment = Math.abs(slider);

    display.innerHTML = `<div class="experiment-screen"><div class="spinner"></div><p>Entscheidung wird übertragen …</p></div>`;
    let outcome: Outcome;
    try {
      outcome = await resolve(
        spec.trialId,
        chosenProfile,
        investment,
        chosenSide ?? undefined,
      );
    } catch (error) {
      if (navigator.onLine) throw error;
      display.innerHTML = `<div class="experiment-screen"><h2>Verbindung unterbrochen</h2><p>Wir versuchen es erneut. Bitte schließen Sie dieses Fenster nicht.</p></div>`;
      await waitUntilOnline();
      outcome = await resolve(
        spec.trialId,
        chosenProfile,
        investment,
        chosenSide ?? undefined,
      );
    }

    display.innerHTML = outcomeHtml(
      isLearning
        ? chosenSide === "left"
          ? leftUrl
          : rightUrl
        : faceUrls[chosenProfile],
      outcome,
    );
    await sleep(1500);
    this.jsPsych.finishTrial({
      domain: "trust",
      trial_id: spec.trialId,
      ordinal: spec.ordinal,
      block: spec.block,
      trial_kind: spec.kind,
      trial_type: spec.trialType,
      condition: spec.condition,
      stimulus_type: spec.stimulusType,
      trial_domain: spec.domain,
      object_left: spec.objectLeft,
      object_right: spec.objectRight,
      question: spec.question,
      fact: spec.fact,
      correct_side: spec.correctSide,
      offered_profiles: spec.offeredProfiles,
      left_profile: spec.leftProfile,
      right_profile: spec.rightProfile,
      face_by_profile: spec.faceByProfile,
      chosen_profile: chosenProfile,
      choice_key: chosenSide,
      choice_rt_ms: firstMoveRt,
      investment,
      investment_rt_ms: firstMoveRt,
      investment_confirmed: true,
      input_transitions: transitions,
      slider_trace: sliderTrace,
      invested: outcome.invested,
      tripled: outcome.tripled,
      returned: outcome.returned,
      payoff: outcome.payoff,
      net: outcome.net,
      outcome_type: outcome.outcomeType,
      outcome_condition: outcome.condition,
      outcome_probability: outcome.probability,
      outcome_random_draw: outcome.randomDraw,
      confidence: investment,
      policy_id: outcome.policyId,
      fixation_planned_ms: spec.fixationMs,
      total_duration_ms: performance.now() - trialStart,
      omitted: choiceOmitted,
      omission_phase: choiceOmitted ? "response" : null,
    });
  }
}

const riskInfo = {
  name: "risk-calibration",
  version: "1.0.0",
  parameters: {
    spec: { type: ParameterType.OBJECT, default: undefined },
    resolveOutcome: { type: ParameterType.FUNCTION, default: undefined },
  },
  data: {},
} as const;

export class RiskTrialPlugin implements JsPsychPlugin<typeof riskInfo> {
  static info = riskInfo;
  constructor(private jsPsych: JsPsych) {}
  async trial(display: HTMLElement, trial: TrialType<typeof riskInfo>) {
    const spec = trial.spec as unknown as RiskTrialSpec;
    const resolve = trial.resolveOutcome as unknown as (
      trialId: string,
      choice: "sure" | "gamble",
    ) => Promise<{ realizedTokens: number; randomDraw: number }>;
    const start = performance.now();
    const gamble = `<strong>${Math.round(spec.gainProbability * 100)} %: ${signed(spec.gainTokens)}</strong><span>${Math.round((1 - spec.gainProbability) * 100)} %: ${signed(spec.lossTokens)}</span>`;
    const sure = `<strong>Sicher ${signed(spec.sureTokens)}</strong><span>Kein Zufall</span>`;
    display.innerHTML = `<div class="experiment-screen"><p class="phase-label">Kalibrierung · Entscheidung ${spec.ordinal} von 24</p><h2>Welche Option wählen Sie?</h2><div class="choice-pair"><div class="choice-option"><kbd>←</kbd>${spec.leftIsGamble ? gamble : sure}</div><div class="choice-option"><kbd>→</kbd>${spec.leftIsGamble ? sure : gamble}</div></div></div>`;
    const key = await waitForKey(["ArrowLeft", "ArrowRight"], 10_000);
    const responseRt = performance.now() - start;
    const choseLeft = key === "ArrowLeft";
    const choice: "sure" | "gamble" = key
      ? choseLeft === spec.leftIsGamble
        ? "gamble"
        : "sure"
      : "sure";
    const result = await resolve(spec.trialId, choice);
    display.innerHTML = `<div class="experiment-screen"><p class="phase-label">Ergebnis</p><div class="outcome-number ${result.realizedTokens < 0 ? "negative" : "positive"}">${signed(result.realizedTokens)} Punkte</div></div>`;
    await sleep(900);
    this.jsPsych.finishTrial({
      domain: "risk",
      trial_id: spec.trialId,
      ordinal: spec.ordinal,
      choice,
      key,
      rt_ms: responseRt,
      sure_tokens: spec.sureTokens,
      gain_tokens: spec.gainTokens,
      loss_tokens: spec.lossTokens,
      gain_probability: spec.gainProbability,
      left_is_gamble: spec.leftIsGamble,
      realized_tokens: result.realizedTokens,
      random_draw: result.randomDraw,
      omitted: key === null,
    });
  }
}

const messageInfo = {
  name: "study-message",
  version: "1.0.0",
  parameters: {
    html: { type: ParameterType.HTML_STRING, default: undefined },
    button: { type: ParameterType.STRING, default: "Weiter" },
  },
  data: {},
} as const;
export class MessagePlugin implements JsPsychPlugin<typeof messageInfo> {
  static info = messageInfo;
  constructor(private jsPsych: JsPsych) {}
  trial(display: HTMLElement, trial: TrialType<typeof messageInfo>) {
    display.innerHTML = `<div class="experiment-screen message-screen">${trial.html}<button autofocus class="primary" data-continue>${trial.button}</button></div>`;
    display
      .querySelector("[data-continue]")!
      .addEventListener(
        "click",
        () => this.jsPsych.finishTrial({ domain: "message" }),
        { once: true },
      );
  }
}

function partnerChoiceHtml(spec: TrustTrialSpec, urls: Record<string, string>) {
  return `<div class="experiment-screen"><p class="phase-label">Runde ${spec.ordinal} · Partner wählen</p><h2>Wem möchten Sie Punkte anvertrauen?</h2><div class="partner-pair"><div><kbd>←</kbd>${faceHtml(urls[spec.leftProfile!])}</div><div><kbd>→</kbd>${faceHtml(urls[spec.rightProfile!])}</div></div><p class="key-hint">Antworten Sie mit der linken oder rechten Pfeiltaste.</p></div>`;
}
function trialHtml(
  spec: TrustTrialSpec,
  leftUrl: string,
  rightUrl: string,
  slider: number,
) {
  const title =
    spec.trialType === "learning_object"
      ? `${spec.question ?? "Welches Objekt passt?"}<div class="fact-prompt">${spec.fact ?? ""}</div>`
      : "Wem möchten Sie vertrauen?";
  const markerColor =
    spec.trialType === "face_reward"
      ? "#16a34a"
      : spec.trialType === "face_punishment"
        ? "#dc2626"
        : "#111827";
  return `<div class="experiment-screen"><p class="phase-label">Runde ${spec.ordinal}</p><h2>${title}</h2><div class="partner-pair"><div>${faceHtml(leftUrl)}<span>←</span></div><div>${faceHtml(rightUrl)}<span>→</span></div></div><div class="trial-timer"><div class="circular-timer" aria-label="Verbleibende Zeit"><svg viewBox="0 0 44 44"><circle class="timer-track" cx="22" cy="22" r="18"/><circle data-timer-progress class="timer-progress" cx="22" cy="22" r="18"/></svg></div><strong data-timer-seconds>4 s&nbsp;</strong><span>verbleibend</span></div><div class="online-slider"><div class="slider-track"><i data-slider-marker style="left:${((slider + 1) / 2) * 100}%;background:${markerColor}"></i></div><span>links / 0.00 EUR</span><span data-slider-value>0.00 EUR</span><span>rechts</span></div><p class="key-hint">←/→ gedrückt halten · automatische Speicherung nach vier Sekunden</p></div>`;
}
function startCircularTimer(display: HTMLElement, durationMs: number) {
  const circle = display.querySelector(
    "[data-timer-progress]",
  ) as SVGCircleElement | null;
  if (!circle) return () => undefined;
  const circumference = 2 * Math.PI * 18;
  circle.style.strokeDasharray = `${circumference}`;
  const start = performance.now();
  let frame = 0;
  const tick = (now: number) => {
    const fraction = Math.max(0, 1 - (now - start) / durationMs);
    circle.style.strokeDashoffset = `${circumference * (1 - fraction)}`;
    const seconds = display.querySelector("[data-timer-seconds]");
    if (seconds)
      seconds.textContent = `${Math.ceil((fraction * durationMs) / 1000)} s\u00a0`;
    if (fraction > 0) frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}
function faceHtml(url: string, className = "") {
  return `<img class="partner-face ${className}" src="${url}" alt="Partnerprofil">`;
}
function investmentHtml(url: string, value: number) {
  return `<div class="experiment-screen"><p class="phase-label">Investition</p>${faceHtml(url, "partner-small")}<h2>Wie viele Ihrer 10 Punkte möchten Sie anvertrauen?</h2><div class="investment-value"><strong data-investment>${value}</strong><span>Punkte</span></div><div class="investment-track"><i data-investment-bar style="width:${value * 10}%"></i></div><div class="investment-labels"><span>0 behalten</span><span>10 anvertrauen</span></div><p class="key-hint">←/→ verändern · Enter bestätigt</p></div>`;
}
function outcomeHtml(url: string, outcome: Outcome) {
  const tone = outcome.net > 0 ? "positive" : outcome.net < 0 ? "negative" : "neutral";
  const label = outcome.net > 0 ? "Gewinn" : outcome.net < 0 ? "Verlust" : "Kein Gewinn oder Verlust";
  return `<div class="experiment-screen"><p class="phase-label">Ergebnis dieser Runde</p><div class="simple-feedback ${tone}"><strong>${outcome.net > 0 ? "+" : ""}${outcome.net.toFixed(2)} EUR</strong><span>&nbsp;${label}</span></div></div>`;
}
function signed(value: number) {
  return `${value >= 0 ? "+" : ""}${value}`;
}
function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}
function waitForKey(keys: string[], timeoutMs: number) {
  return new Promise<string | null>((resolve) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const handler = (event: KeyboardEvent) => {
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      cleanup();
      resolve(event.key);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      window.removeEventListener("keydown", handler);
    };
    window.addEventListener("keydown", handler);
  });
}
function waitForInvestment(timeoutMs: number, onChange: (key: string) => void) {
  return new Promise<{ confirmed: boolean }>((resolve) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      resolve({ confirmed: false });
    }, timeoutMs);
    const handler = (event: KeyboardEvent) => {
      if (
        !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"].includes(
          event.key,
        )
      )
        return;
      event.preventDefault();
      if (event.key === "Enter") {
        cleanup();
        resolve({ confirmed: true });
      } else onChange(event.key);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      window.removeEventListener("keydown", handler);
    };
    window.addEventListener("keydown", handler);
  });
}
function waitForContinuousArrows(
  timeoutMs: number,
  onChange: (key: string) => void,
) {
  return new Promise<void>((resolve) => {
    const held = new Set<string>();
    const start = performance.now();
    const down = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        cleanup();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      held.add(event.key);
      onChange(event.key);
    };
    const up = (event: KeyboardEvent) => held.delete(event.key);
    const tick = () => {
      if (performance.now() - start >= timeoutMs) return cleanup();
      held.forEach((key) => onChange(key));
      requestAnimationFrame(tick);
    };
    const cleanup = () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      resolve();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    requestAnimationFrame(tick);
  });
}
function waitUntilOnline() {
  return navigator.onLine
    ? Promise.resolve()
    : new Promise<void>((resolve) =>
        window.addEventListener("online", () => resolve(), { once: true }),
      );
}
