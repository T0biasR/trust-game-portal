import type { RuntimeContext, RunPayload, TaskDefinition } from "../core/types";
import { makeProgress, showMessage } from "../core/ui";
import { preloadImages } from "../core/preload";
import { responseFromSlider, runSliderTrial } from "./slider";

const faceAssets = import.meta.glob("../../Hariri Tasks/faces-berlin/*.jpg", { query: "?url", import: "default" }) as Record<string, () => Promise<string>>;
const objectAssets = import.meta.glob("../../Hariri Tasks/objects-berlin/*.jpg", { query: "?url", import: "default" }) as Record<string, () => Promise<string>>;
const instructionAssets = import.meta.glob("../../Hariri Tasks/haririslider instructions/*.png", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

type FaceMeta = {
  key: string;
  file: string;
  identity: string;
  age: string;
  gender: string;
  emotion: "happy" | "sad";
  intensity: number;
};

type Trial = {
  condition: 0 | 2 | 3;
  trialType: "objects" | "happy" | "sad";
  ref: string;
  left: string;
  right: string;
  correct: 1 | 2;
  question: string;
  schedOnset: number;
  schedDuration: number;
  intensityLeft?: number;
  intensityRight?: number;
  intensityDiff?: number;
  edgesLeft?: number;
  edgesRight?: number;
  edgesDiff?: number;
};

const TIMING = {
  trialMs: 3500,
  responseMs: 3000,
  feedbackMs: 500,
  isiMs: 500,
  fixationMs: 0,
  leftRightDelayMs: 500,
  blockMs: 20000,
  baselineMs: 20000,
};

const LOSS_U0 = 0.25;
const LOSS_MULT = 2.0;
const BET_VALUE = 1.0;
const KEYS_ACTION = [-1.5, -1.3, 1.3, 1.5];
const RESIST_MIN = 0.05;
const SPEED_MIN = 15;
const MIRROR_SPEED_SCALE = 0.08;
const RESIST_GLOBAL_SCALE = 2.1;
const RESIST_CAP = 2.4;
const RESIST_SOFTNESS = 0.5;
const W_PARAMS = { t1: 1 / 3, t2: 2 / 3, s1: 0.5, s2: 1.0, s3: 1.6 };

function basename(path: string) {
  return path.split("/").pop() ?? path;
}

function parseFaces(): FaceMeta[] {
  const re = /^(\d+)_([ymo])_([fm])-(happy|sad)-(\d{3})\.jpg$/i;
  return Object.entries(faceAssets).flatMap(([key, url]) => {
    const file = basename(key);
    const m = file.match(re);
    if (!m) return [];
    const intensity = Number(m[5]);
    if (!(intensity <= 10 || (intensity >= 30 && intensity <= 80) || intensity >= 100)) return [];
    return [{ key, file, identity: m[1], age: m[2].toLowerCase(), gender: m[3].toLowerCase(), emotion: m[4].toLowerCase() as "happy" | "sad", intensity }];
  });
}

function parseEdges(file: string) {
  const m = basename(file).match(/^poly-(\d+)-(\d+)\.jpg$/i);
  return m ? Number(m[1]) : null;
}

function smoothstep(t: number) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function lossGate(u: number) {
  return smoothstep((Math.max(0, Math.min(1, u)) - LOSS_U0) / (1 - LOSS_U0));
}

function wPiecewise(u: number) {
  const x = Math.max(0, Math.min(1, u));
  const c1 = W_PARAMS.s1 * W_PARAMS.t1;
  const c2 = c1 + W_PARAMS.s2 * (W_PARAMS.t2 - W_PARAMS.t1);
  if (x <= W_PARAMS.t1) return W_PARAMS.s1 * x;
  if (x <= W_PARAMS.t2) return c1 + W_PARAMS.s2 * (x - W_PARAMS.t1);
  return c2 + W_PARAMS.s3 * (x - W_PARAMS.t2);
}

function wUnit(u: number) {
  return wPiecewise(u) / wPiecewise(1);
}

function rewardMagnitude(pos: number, lossSide: "left" | "right") {
  let mag = lossGate(Math.abs(pos)) * wUnit(Math.abs(pos));
  if (lossSide === "left" && pos < 0) mag *= LOSS_MULT;
  if (lossSide === "right" && pos > 0) mag *= LOSS_MULT;
  return mag;
}

function markerColor(pos: number) {
  const hue = (1 - Math.abs(pos)) * 120;
  return `hsl(${hue}, 100%, 50%)`;
}

function buildSchedule(ctx: RuntimeContext): string[] {
  const blockOrder: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    blockOrder.push(...ctx.rng.shuffle(["happy", "sad", "objects"]));
  }
  return blockOrder;
}

function makeFaceTrial(ctx: RuntimeContext, faces: FaceMeta[], emotion: "happy" | "sad", schedOnset: number): Trial {
  const combos = ctx.rng.shuffle(["y/f", "y/m", "m/f", "m/m", "o/f", "o/m"]);
  for (const combo of combos) {
    const [age, gender] = combo.split("/");
    const pool = faces.filter((f) => f.emotion === emotion && f.age === age && f.gender === gender);
    const refs = pool.filter((f) => f.intensity >= 100);
    const matches = pool.filter((f) => f.intensity >= 30 && f.intensity <= 80);
    const foils = pool.filter((f) => f.intensity <= 10);
    if (!refs.length || !matches.length || !foils.length) continue;
    const ref = ctx.rng.choice(refs);
    const matchCandidates = matches.filter((f) => f.identity !== ref.identity);
    if (!matchCandidates.length) continue;
    const match = ctx.rng.choice(matchCandidates);
    const foilCandidates = foils.filter((f) => f.identity !== ref.identity && f.identity !== match.identity);
    if (!foilCandidates.length) continue;
    const foil = ctx.rng.choice(foilCandidates);
    const leftIsMatch = ctx.rng.next() < 0.5;
    const left = leftIsMatch ? match : foil;
    const right = leftIsMatch ? foil : match;
    return {
      condition: emotion === "happy" ? 2 : 3,
      trialType: emotion,
      ref: ref.key,
      left: left.key,
      right: right.key,
      correct: leftIsMatch ? 1 : 2,
      question: "Wer zeigt dieselbe Emotion wie das obere Bild?",
      schedOnset,
      schedDuration: TIMING.trialMs,
      intensityLeft: left.intensity,
      intensityRight: right.intensity,
      intensityDiff: Math.abs(left.intensity - right.intensity),
    };
  }
  throw new Error(`Not enough face stimuli for ${emotion}`);
}

function makeObjectTrial(ctx: RuntimeContext, schedOnset: number): Trial {
  const byEdges = new Map<number, string[]>();
  Object.keys(objectAssets).forEach((key) => {
    const edges = parseEdges(key);
    if (!edges) return;
    byEdges.set(edges, [...(byEdges.get(edges) ?? []), key]);
  });
  const edges = ctx.rng.choice(Array.from(byEdges.keys()).filter((e) => (byEdges.get(e)?.length ?? 0) >= 2));
  const refs = byEdges.get(edges)!;
  const ref = ctx.rng.choice(refs);
  let match = ctx.rng.choice(refs);
  while (match === ref) match = ctx.rng.choice(refs);
  const foilEdges = ctx.rng.choice(Array.from(byEdges.keys()).filter((e) => e !== edges));
  const foil = ctx.rng.choice(byEdges.get(foilEdges)!);
  const leftIsMatch = ctx.rng.next() < 0.5;
  return {
    condition: 0,
    trialType: "objects",
    ref,
    left: leftIsMatch ? match : foil,
    right: leftIsMatch ? foil : match,
    correct: leftIsMatch ? 1 : 2,
    question: "Welche Form besitzt dieselbe Anzahl an Ecken?",
    schedOnset,
    schedDuration: TIMING.trialMs,
    edgesLeft: leftIsMatch ? edges : foilEdges,
    edgesRight: leftIsMatch ? foilEdges : edges,
    edgesDiff: Math.abs(edges - foilEdges),
  };
}

function buildTrials(ctx: RuntimeContext): Trial[] {
  const faces = parseFaces();
  const blockOrder = buildSchedule(ctx);
  const trials: Trial[] = [];
  let t = 0;
  blockOrder.forEach((block, blockIndex) => {
    for (let j = 0; j < 5; j += 1) {
      if (block === "happy") trials.push(makeFaceTrial(ctx, faces, "happy", t + j * 4000));
      else if (block === "sad") trials.push(makeFaceTrial(ctx, faces, "sad", t + j * 4000));
      else trials.push(makeObjectTrial(ctx, t + j * 4000));
    }
    t += TIMING.blockMs;
    if ((blockIndex + 1) % 3 === 0) t += TIMING.baselineMs;
  });
  return trials;
}

async function runTutorial(ctx: RuntimeContext) {
  await showMessage(ctx.root, "Schieberegler-Tutorial<br><br>Bewegen Sie den Regler mit 1/2 nach links und mit 3/4 nach rechts.", ["1", "2", "3", "4"], 4000, ctx.keyboard);
}

export const haririSliderTask: TaskDefinition = {
  id: "hariri-slider",
  title: "Face Matching: Hariri Slider",
  description: "Active Hariri slider version with happy, sad, and object matching blocks.",
  async run(ctx): Promise<RunPayload> {
    const keyedTrials = buildTrials(ctx);
    const keyedPractice = ctx.rng.shuffle(keyedTrials.slice()).slice(0, 6);
    const assetUrls = await resolveAssetUrls([...keyedPractice, ...keyedTrials]);
    const trials = keyedTrials.map((t) => withUrls(t, assetUrls));
    const practice = keyedPractice.map((t) => withUrls(t, assetUrls));
    const urls = [...new Set([...practice, ...trials].flatMap((t) => [t.ref, t.left, t.right]))];
    const progress = makeProgress(ctx.root, "Loading HaririSlider stimuli");
    await preloadImages(urls, progress);
    await runTutorial(ctx);
    await showMessage(ctx.root, "Wir beginnen mit einem Probedurchlauf.<br><br>Drücken Sie eine Taste.", ["1", "2", "3", "4"], 3000, ctx.keyboard);
    for (const p of practice) {
      await runOne(ctx, p, true, 0);
    }
    await showMessage(ctx.root, "Die Hauptaufgabe beginnt jetzt.<br><br>Drücken Sie eine Taste.", ["1", "2", "3", "4"], 3000, ctx.keyboard);
    ctx.clock.reset();
    const rows: Record<string, unknown>[] = [];
    const traces: Record<string, unknown>[] = [];
    let cumulative = 0;
    for (let i = 0; i < trials.length; i += 1) {
      const row = trials[i];
      await ctx.clock.waitUntil(row.schedOnset, undefined);
      const result = await runOne(ctx, row, false, cumulative);
      cumulative += Number(result.reward);
      rows.push({
        participant: ctx.meta.participantId,
        session: ctx.meta.session,
        task_version: "HaririSliderBrowser",
        trial_id: i + 1,
        trial_index: i,
        trial_type: row.trialType,
        condition: row.condition,
        onset: result.onset / 1000,
        duration: TIMING.trialMs / 1000,
        rt: result.rt === null ? null : result.rt / 1000,
        stim_ref: row.ref,
        stim_left: row.left,
        stim_right: row.right,
        question: row.question,
        correct_response: row.correct,
        actual_response: responseFromSlider(result.pos),
        responded: result.responded,
        accuracy: responseFromSlider(result.pos) === row.correct ? 1 : 0,
        slider_position: result.pos,
        slider_movement_count: result.directionChanged ? 1 : 0,
        bet_placed: BET_VALUE,
        reward_earned: result.reward,
        cumulative_score: cumulative,
        intensity_left: row.intensityLeft,
        intensity_right: row.intensityRight,
        intensity_diff: row.intensityDiff,
        edges_left: row.edgesLeft,
        edges_right: row.edgesRight,
        edges_diff: row.edgesDiff,
        sched_onset: row.schedOnset / 1000,
      });
      traces.push(...result.trace.map((point, idx) => ({ trial_id: i + 1, sample: idx, t: point.t / 1000, slider_position: point.pos })));
      await ctx.logger.checkpoint({ session: sessionInfo(ctx), schedule: trials, trials: rows, traces });
    }
    const payload = { session: sessionInfo(ctx), schedule: trials, trials: rows, traces, quality: ctx.logger.quality };
    await ctx.logger.finish(payload);
    return payload;
  },
};

async function runOne(ctx: RuntimeContext, row: Trial, practice: boolean, cumulative: number) {
  const correctLossSide = row.correct === 1 ? "right" : "left";
  const moveTime = Math.max(0.001, (TIMING.responseMs - TIMING.feedbackMs) / 1000);
  const speed = Math.max(SPEED_MIN, 1 / (moveTime * RESIST_MIN * Math.max(...KEYS_ACTION.map(Math.abs))));
  const result = await runSliderTrial(ctx, {
    ref: row.ref,
    left: row.left,
    right: row.right,
    question: row.question,
    showRef: true,
    showLabels: true,
    markerMode: "confidence",
  }, {
    fixationMs: 0,
    responseMs: TIMING.trialMs - TIMING.feedbackMs,
    feedbackMs: TIMING.feedbackMs,
    isiMs: practice ? 500 : TIMING.isiMs,
    leftRightDelayMs: TIMING.leftRightDelayMs,
  }, {
    keysAction: KEYS_ACTION,
    responseMs: TIMING.responseMs,
    dtMaxMs: 10,
    stepScale: (i, pos, dtS) => {
      const resistance = Math.min(RESIST_CAP, rewardMagnitude(pos, correctLossSide) * RESIST_GLOBAL_SCALE);
      return KEYS_ACTION[i] * dtS * speed * MIRROR_SPEED_SCALE / (1 + RESIST_SOFTNESS * resistance);
    },
    valueLabels: (pos) => {
      const u = Math.abs(pos);
      const win = BET_VALUE * lossGate(u) * wUnit(u);
      const loss = LOSS_MULT * BET_VALUE * lossGate(u) * wUnit(u);
      if (pos < 0) return { left: `+${win.toFixed(2)} EUR`, right: `-${loss.toFixed(2)} EUR` };
      if (pos > 0) return { left: `-${loss.toFixed(2)} EUR`, right: `+${win.toFixed(2)} EUR` };
      return { left: "0.00 EUR", right: "0.00 EUR" };
    },
    feedbackFor: (pos) => {
      const isCorrect = (pos < 0 && row.correct === 1) || (pos > 0 && row.correct === 2);
      const u = Math.abs(pos);
      const win = BET_VALUE * lossGate(u) * wUnit(u);
      const loss = LOSS_MULT * BET_VALUE * lossGate(u) * wUnit(u);
      const reward = isCorrect ? win : -loss;
      return { text: `${reward >= 0 ? "+" : ""}${reward.toFixed(2)} EUR`, color: reward < 0 ? "#FFAAAA" : reward > 0 ? "#AAFFAA" : "white", extra: { reward } };
    },
  });
  return {
    onset: result.onset,
    rt: result.rt,
    pos: result.finalPos,
    responded: result.responded,
    directionChanged: result.directionChanged,
    trace: result.trace,
    reward: Number(result.feedback.extra?.reward ?? 0),
    cumulative,
  };
}

async function resolveAssetUrls(trials: Trial[]) {
  const keys = [...new Set(trials.flatMap((t) => [t.ref, t.left, t.right]))];
  const pairs = await Promise.all(keys.map(async (key) => {
    const loader = faceAssets[key] ?? objectAssets[key];
    if (!loader) throw new Error(`No asset loader for ${key}`);
    return [key, await loader()] as const;
  }));
  return new Map(pairs);
}

function withUrls(trial: Trial, urls: Map<string, string>): Trial {
  return {
    ...trial,
    ref: urls.get(trial.ref) ?? trial.ref,
    left: urls.get(trial.left) ?? trial.left,
    right: urls.get(trial.right) ?? trial.right,
  };
}

function sessionInfo(ctx: RuntimeContext) {
  return { ...ctx.meta, taskSource: "HaririSlider_DeCoDe26.py", parityPolicy: "fix-clear-bugs-only" };
}
