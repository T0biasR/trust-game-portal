import type { RuntimeContext } from "../core/types";
import { el } from "../core/ui";

export type SliderTrialVisual = {
  ref?: string;
  left: string;
  right: string;
  question: string;
  showRef: boolean;
  showLabels: boolean;
  markerMode: "black" | "reward" | "punishment" | "confidence";
};

export type SliderPhysics = {
  keysAction: number[];
  responseMs: number;
  dtMaxMs?: number;
  stepScale?: (keyIndex: number, pos: number, dtS: number) => number;
  valueLabels?: (pos: number) => { left: string; right: string };
  feedbackFor?: (pos: number) => { text: string; color: string; extra?: Record<string, unknown> };
  traceBinMs?: number;
};

export type SliderRunResult = {
  onset: number;
  duration: number;
  rt: number | null;
  finalPos: number;
  responded: boolean;
  directionChanged: boolean;
  trace: Array<{ t: number; pos: number }>;
  binnedTrace?: Record<string, number>;
  feedback: { text: string; color: string; extra?: Record<string, unknown> };
};

const KEYS = ["1", "2", "3", "4"];

export async function runSliderTrial(
  ctx: RuntimeContext,
  visual: SliderTrialVisual,
  timing: { fixationMs: number; responseMs: number; feedbackMs: number; isiMs: number; leftRightDelayMs?: number },
  physics: SliderPhysics,
): Promise<SliderRunResult> {
  const root = ctx.root;
  root.replaceChildren();
  const stage = el("div", { class: "experiment-stage" });
  const layout = el("div", { class: "stim-layout" });
  stage.append(layout);
  root.append(stage);

  const fixation = el("div", { class: "center-screen fixation", text: "." });
  const ref = el("img", { class: "stim ref", src: visual.ref ?? "", alt: "" }) as HTMLImageElement;
  const left = el("img", { class: "stim left", src: visual.left, alt: "" }) as HTMLImageElement;
  const right = el("img", { class: "stim right", src: visual.right, alt: "" }) as HTMLImageElement;
  const question = el("div", { class: "task-question", text: visual.question });
  const marker = el("div", { class: "slider-marker" }) as HTMLElement;
  const leftVal = el("div", { text: "0.00 EUR" });
  const rightVal = el("div", { text: "0.00 EUR" });
  const slider = el("div", { class: "slider-wrap" }, [
    el("div", { class: "slider-track" }, [marker]),
    el("div", { class: "slider-values" }, [leftVal, rightVal]),
  ]);
  layout.append(ref, left, right, question, slider);
  if (!visual.showRef) ref.style.display = "none";
  left.style.display = "none";
  right.style.display = "none";
  slider.style.display = "none";
  if (!visual.showLabels) {
    leftVal.textContent = "";
    rightVal.textContent = "";
  }

  const setMarker = (pos: number) => {
    marker.style.left = `${50 + pos * 50}%`;
    if (visual.markerMode === "reward") marker.style.background = marker.style.borderColor = "#00CC44";
    else if (visual.markerMode === "punishment") marker.style.background = marker.style.borderColor = "#CC2200";
    else if (visual.markerMode === "confidence") {
      const m = Math.abs(pos);
      const hue = (1 - m) * 120;
      marker.style.background = marker.style.borderColor = `hsl(${hue}, 100%, 50%)`;
    } else marker.style.background = marker.style.borderColor = "#000";
  };

  const onset = ctx.clock.now();
  let pos = 0;
  let rt: number | null = null;
  let lastDir = 0;
  let directionChanged = false;
  let previousNow = performance.now();
  const trace: Array<{ t: number; pos: number }> = [];
  const binned: Record<string, number> = {};
  let nextBin = 0;
  setMarker(pos);

  while (ctx.clock.now() - onset < timing.fixationMs) {
    root.replaceChildren(fixation);
    await ctx.clock.raf();
  }
  root.replaceChildren(stage);

  const responseStart = ctx.clock.now();
  const responseEnd = responseStart + timing.responseMs;
  while (ctx.clock.now() < responseEnd) {
    const elapsed = ctx.clock.now() - responseStart;
    if (elapsed >= (timing.leftRightDelayMs ?? 0)) {
      left.style.display = "";
      right.style.display = "";
      slider.style.display = "";
    }
    const now = performance.now();
    const dtMs = Math.min(now - previousNow, physics.dtMaxMs ?? 50);
    previousNow = now;
    const states = ctx.keyboard.snapshot(KEYS);
    let dir = 0;
    states.forEach((pressed, i) => {
      if (!pressed) return;
      if (i < 2) dir -= 1;
      else dir += 1;
      if (rt === null && Math.abs(pos) <= 0.01) rt = ctx.clock.now() - responseStart;
      const dtS = dtMs / 1000;
      const step = physics.stepScale
        ? physics.stepScale(i, pos, dtS)
        : physics.keysAction[i] * dtS;
      pos = Math.max(-1, Math.min(1, pos + step));
    });
    if (dir !== 0) {
      if (lastDir !== 0 && dir !== lastDir) directionChanged = true;
      lastDir = dir;
    }
    setMarker(pos);
    const labels = physics.valueLabels?.(pos);
    if (labels) {
      leftVal.textContent = labels.left;
      rightVal.textContent = labels.right;
    }
    const t = ctx.clock.now() - responseStart;
    trace.push({ t, pos });
    if (physics.traceBinMs) {
      while (nextBin <= timing.fixationMs + t) {
        binned[`t${(nextBin / 1000).toFixed(2)}`] = Number(pos.toFixed(2));
        nextBin += physics.traceBinMs;
      }
    }
    await ctx.clock.raf();
  }

  const feedback = physics.feedbackFor?.(pos) ?? { text: "", color: "white" };
  const disc = el("div", { class: "feedback-disc", text: feedback.text });
  disc.style.background = feedback.color;
  layout.append(disc);
  const feedbackStart = ctx.clock.now();
  while (ctx.clock.now() - feedbackStart < timing.feedbackMs) {
    await ctx.clock.raf();
  }
  disc.remove();
  const isiStart = ctx.clock.now();
  root.replaceChildren(fixation);
  while (ctx.clock.now() - isiStart < timing.isiMs) {
    await ctx.clock.raf();
  }

  return {
    onset,
    duration: ctx.clock.now() - onset,
    rt,
    finalPos: pos,
    responded: Math.abs(pos) > 0.01,
    directionChanged,
    trace,
    binnedTrace: physics.traceBinMs ? binned : undefined,
    feedback,
  };
}

export function responseFromSlider(pos: number) {
  if (pos < -0.01) return 1;
  if (pos > 0.01) return 2;
  return null;
}
