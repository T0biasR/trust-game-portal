import type { RuntimeContext, RunPayload, TaskDefinition } from "../core/types";
import { makeProgress, showMessage } from "../core/ui";
import { preloadImages } from "../core/preload";
import { responseFromSlider, runSliderTrial } from "./slider";
import outcomeConfig from "../../Trust game/paradigm_outcomes.json";
import cbConfig from "../../Trust game/counterbalancing.json";
import itemConfig from "../../Trust game/item_pool.json";

const stimAssets = import.meta.glob("../../Trust game/stimuli/*.png", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const instructionAssets = import.meta.glob("../../Trust game/instructions/*.png", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

type TrustTrial = {
  trial_id: number;
  trial_type: "learning_object" | "face_reward" | "face_punishment" | "baseline";
  stimulus_left: string;
  stimulus_right: string;
  stimulus_left_image: string;
  stimulus_right_image: string;
  question: string;
  cb_group: string;
  trust_level_left: string | null;
  trust_level_right: string | null;
  domain: string | null;
  fact_presented: string | null;
  correct_response: 1 | 2 | null;
  block_id: number;
  block_type: "learning" | "trust" | "baseline";
};

const KEYS_ACTION = [-1.5, -0.75, 0.75, 1.5];

function assetFor(id: string, sex: "male" | "female") {
  const suffix = id.startsWith("face") ? (sex === "male" ? "_m" : "_f") : "";
  const needle = `${id}${suffix}.png`;
  const entry = Object.entries(stimAssets).find(([key]) => key.endsWith(needle));
  if (!entry) throw new Error(`Missing Trust Game stimulus: ${needle}`);
  return entry[1];
}

function instructionUrls() {
  return Object.entries(instructionAssets)
    .filter(([key]) => /TrustGame_Instructions_0[123]\.png$/.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, url]) => url);
}

function getCbGroup(pidRaw: string) {
  const pid = Number(pidRaw);
  if (!Number.isFinite(pid)) return "CB1";
  if (pid % 3 === 0) return "CB3";
  if (pid % 2 === 0) return "CB2";
  return "CB1";
}

function trustRank(level: string | null) {
  return level === "high" ? 3 : level === "neutral" ? 2 : level === "low" ? 1 : 0;
}

function buildTrustSchedule(ctx: RuntimeContext, nUnits: number): TrustTrial[] {
  const cbGroup = getCbGroup(ctx.meta.participantId);
  const cb = (cbConfig as any).cb_groups[cbGroup];
  const faceTrust = new Map<string, string>();
  cb.face_assignments.forEach((a: any) => faceTrust.set(a.face_id, a.assigned_trust_level));
  const objItems = new Map<string, Record<string, string>>();
  cb.object_assignments.forEach((a: any) => {
    const rec: Record<string, string> = {};
    a.fact_sets.forEach((fs: any) => { rec[fs.domain] = fs.item; });
    objItems.set(a.object_id, rec);
  });

  const faceIds = ["face_01", "face_02", "face_03"];
  const objIds = ["obj_01", "obj_02", "obj_03"];
  const objDomains = ["object_origin", "object_material"];
  const facePairs = [[faceIds[0], faceIds[1]], [faceIds[0], faceIds[2]], [faceIds[1], faceIds[2]]];
  const combos = objDomains.flatMap((domain) => objIds.flatMap((target) => objIds.filter((foil) => foil !== target).map((foil) => ({ target, domain, foil }))));

  const makeLearning = (target: string, domain: string, foil: string): TrustTrial => {
    const domainItems = (itemConfig as any).domains[domain].items;
    const itemId = objItems.get(target)![domain];
    const item = domainItems[itemId];
    const leftCorrect = ctx.rng.next() < 0.5;
    const left = leftCorrect ? target : foil;
    const right = leftCorrect ? foil : target;
    return {
      trial_id: 0,
      trial_type: "learning_object",
      stimulus_left: left,
      stimulus_right: right,
      stimulus_left_image: assetFor(left, ctx.meta.sex),
      stimulus_right_image: assetFor(right, ctx.meta.sex),
      question: item.question_DE,
      cb_group: cbGroup,
      trust_level_left: null,
      trust_level_right: null,
      domain,
      fact_presented: item.fact_DE,
      correct_response: leftCorrect ? 1 : 2,
      block_id: 0,
      block_type: "learning",
    };
  };

  const learning: TrustTrial[] = [];
  while (learning.length < nUnits * 4) {
    for (const combo of ctx.rng.shuffle(combos.slice())) {
      learning.push(makeLearning(combo.target, combo.domain, combo.foil));
      if (learning.length >= nUnits * 4) break;
    }
  }
  const learningBlocks = Array.from({ length: nUnits }, (_, i) => learning.slice(i * 4, i * 4 + 4));

  const makeTrust = (type: "face_reward" | "face_punishment"): TrustTrial => {
    const pair = ctx.rng.choice(facePairs);
    const flip = ctx.rng.next() < 0.5;
    const left = flip ? pair[1] : pair[0];
    const right = flip ? pair[0] : pair[1];
    const tlLeft = faceTrust.get(left)!;
    const tlRight = faceTrust.get(right)!;
    const correct = trustRank(tlLeft) > trustRank(tlRight) ? 1 : trustRank(tlRight) > trustRank(tlLeft) ? 2 : null;
    return {
      trial_id: 0,
      trial_type: type,
      stimulus_left: left,
      stimulus_right: right,
      stimulus_left_image: assetFor(left, ctx.meta.sex),
      stimulus_right_image: assetFor(right, ctx.meta.sex),
      question: "",
      cb_group: cbGroup,
      trust_level_left: tlLeft,
      trust_level_right: tlRight,
      domain: null,
      fact_presented: null,
      correct_response: correct,
      block_id: 0,
      block_type: "trust",
    };
  };

  const trustBlocks = Array.from({ length: nUnits }, () => {
    const block = [makeTrust("face_reward"), makeTrust("face_reward"), makeTrust("face_punishment"), makeTrust("face_punishment")];
    return ctx.rng.shuffle(block);
  });

  const all: TrustTrial[] = [];
  for (let i = 0; i < nUnits; i += 1) {
    const order = ctx.rng.shuffle(["learning", "trust"]);
    order.forEach((kind) => {
      const block = kind === "learning" ? learningBlocks[i] : trustBlocks[i];
      block.forEach((trial) => {
        trial.block_id = i + 1;
        all.push(trial);
      });
    });
    all.push({
      trial_id: 0,
      trial_type: "baseline",
      stimulus_left: "",
      stimulus_right: "",
      stimulus_left_image: "",
      stimulus_right_image: "",
      question: "",
      cb_group: cbGroup,
      trust_level_left: null,
      trust_level_right: null,
      domain: null,
      fact_presented: null,
      correct_response: null,
      block_id: i + 1,
      block_type: "baseline",
    });
  }
  all.forEach((trial, i) => { trial.trial_id = i + 1; });
  return all;
}

function sampleOutcome(ctx: RuntimeContext, trust: string | null, condition: "reward" | "punishment") {
  if (!trust) return "break_even";
  const probs = (outcomeConfig as any).conditions[condition].trust_levels[trust];
  const r = ctx.rng.next();
  return condition === "reward" ? (r < probs.p_win ? "win" : "break_even") : (r < probs.p_lose ? "lose" : "break_even");
}

function outcomeValue(type: string, pos: number) {
  const rate = (outcomeConfig as any).outcome_rates[type].net_gain_rate;
  return Math.round(rate * Math.abs(pos) * 100) / 100;
}

async function showInstructions(ctx: RuntimeContext) {
  for (const url of instructionUrls()) {
    ctx.root.replaceChildren();
    const img = document.createElement("img");
    img.src = url;
    img.style.width = "100vw";
    img.style.height = "100vh";
    img.style.objectFit = "contain";
    ctx.root.append(img);
    await showMessage(ctx.root, `<img src="${url}" style="width:100vw;height:100vh;object-fit:contain">`, ["1", "2", "3", "4"], 4000, ctx.keyboard);
  }
}

export const trustGameTask: TaskDefinition = {
  id: "trust-game",
  title: "Trust Game",
  description: "Active 08-07 block-design trust game with object learning and face trust trials.",
  async run(ctx): Promise<RunPayload> {
    const schedule = buildTrustSchedule(ctx, 8);
    const practice = buildTrustSchedule(ctx, 3).filter((t) => t.trial_type !== "baseline").slice(0, 12);
    const urls = [...instructionUrls(), ...schedule.concat(practice).flatMap((t) => [t.stimulus_left_image, t.stimulus_right_image]).filter(Boolean)];
    const progress = makeProgress(ctx.root, "Loading Trust Game stimuli");
    await preloadImages(urls, progress);
    await showInstructions(ctx);
    await showMessage(ctx.root, "Schieberegler-Tutorial<br><br>1/2 bewegen nach links, 3/4 bewegen nach rechts.", ["1", "2", "3", "4"], 4000, ctx.keyboard);
    for (const p of practice) await runActiveTrial(ctx, p, true, 0);
    await showMessage(ctx.root, "Warten auf Start.<br><br>Drücken Sie 6, um die Hauptaufgabe zu beginnen.", ["6"], 0, ctx.keyboard);
    ctx.clock.reset();
    const rows: Record<string, unknown>[] = [];
    const traces: Record<string, unknown>[] = [];
    let cumulative = 0;
    for (const trial of schedule) {
      if (trial.trial_type === "baseline") {
        const onset = ctx.clock.now();
        await showMessage(ctx.root, "<span class='fixation'>.</span>", [], 22000, { clear: ctx.keyboard.clear, consumeAny: () => null });
        rows.push(baseRow(ctx, trial, onset, 22000, cumulative));
        continue;
      }
      const result = await runActiveTrial(ctx, trial, false, cumulative);
      cumulative += result.rewardEarned ?? 0;
      rows.push({
        ...baseRow(ctx, trial, result.onset, 4000, cumulative),
        rt: result.rt === null ? null : result.rt / 1000,
        actual_response: responseFromSlider(result.finalPos),
        accuracy: trial.correct_response === null || responseFromSlider(result.finalPos) === null ? null : responseFromSlider(result.finalPos) === trial.correct_response ? 1 : 0,
        responded: result.responded,
        slider_position: result.finalPos,
        confidence: Math.abs(result.finalPos),
        tripled_stake_eur: trial.trial_type.startsWith("face") ? Math.round(Math.abs(result.finalPos) * 3 * 100) / 100 : null,
        outcome_type: result.outcomeType,
        reward_earned_cent: result.rewardEarned === null ? null : Math.round(result.rewardEarned * 1000) / 10,
        cumulative_score_cent: Math.round(cumulative * 1000) / 10,
      });
      if (result.binnedTrace) traces.push({ participant: ctx.meta.participantId, session: ctx.meta.session, trial_index: trial.trial_id, ...result.binnedTrace });
      await ctx.logger.checkpoint({ session: sessionInfo(ctx), schedule, trials: rows, traces });
    }
    const payload = { session: sessionInfo(ctx), schedule, trials: rows, traces, quality: ctx.logger.quality };
    await ctx.logger.finish(payload);
    return payload;
  },
};

async function runActiveTrial(ctx: RuntimeContext, trial: TrustTrial, practice: boolean, cumulative: number) {
  const isLearning = trial.trial_type.includes("learning");
  let outcomeType: string | null = null;
  const result = await runSliderTrial(ctx, {
    left: trial.stimulus_left_image,
    right: trial.stimulus_right_image,
    question: trial.question,
    showRef: false,
    showLabels: !isLearning,
    markerMode: trial.trial_type.includes("reward") ? "reward" : trial.trial_type.includes("punishment") ? "punishment" : "black",
  }, {
    fixationMs: 500,
    responseMs: 4000,
    feedbackMs: 500,
    isiMs: practice ? 500 : 500,
  }, {
    keysAction: KEYS_ACTION,
    responseMs: 4000,
    traceBinMs: 20,
    valueLabels: (pos) => isLearning
      ? { left: "", right: "" }
      : { left: `${Math.max(0, -pos).toFixed(2)} EUR`, right: `${Math.max(0, pos).toFixed(2)} EUR` },
    feedbackFor: (pos) => {
      const actual = responseFromSlider(pos);
      if (isLearning) {
        const acc = actual === null ? null : actual === trial.correct_response;
        return { text: acc === true ? "Korrekt!" : acc === false ? "Falsch!" : "", color: acc === true ? "#AAFFAA" : acc === false ? "#FFAAAA" : "white", extra: { reward: null, outcomeType: null } };
      }
      const condition = trial.trial_type.includes("reward") ? "reward" : "punishment";
      const trust = actual === 1 ? trial.trust_level_left : actual === 2 ? trial.trust_level_right : null;
      outcomeType = sampleOutcome(ctx, trust, condition);
      const reward = outcomeValue(outcomeType, pos);
      return { text: `${reward >= 0 ? "+" : ""}${reward.toFixed(2)} EUR`, color: outcomeType === "win" ? "#AAFFAA" : outcomeType === "lose" ? "#FFAAAA" : "white", extra: { reward, outcomeType } };
    },
  });
  return {
    onset: result.onset,
    rt: result.rt,
    finalPos: result.finalPos,
    responded: result.responded,
    binnedTrace: result.binnedTrace,
    outcomeType,
    rewardEarned: result.feedback.extra?.reward as number | null,
    cumulative,
  };
}

function baseRow(ctx: RuntimeContext, trial: TrustTrial, onsetMs: number, durationMs: number, cumulative: number) {
  return {
    participant: ctx.meta.participantId,
    session: ctx.meta.session,
    participant_sex: ctx.meta.sex,
    task_version: "TrustGame_SocialNonSocial_08072026_browser",
    trial_id: trial.trial_id,
    trial_type: trial.trial_type,
    onset: onsetMs / 1000,
    duration: durationMs / 1000,
    stim_left: trial.stimulus_left,
    stim_right: trial.stimulus_right,
    question: trial.question,
    cb_group: trial.cb_group,
    trust_level_left: trial.trust_level_left,
    trust_level_right: trial.trust_level_right,
    domain: trial.domain,
    fact_presented: trial.fact_presented,
    response_type: trial.trial_type === "baseline" ? null : "slider",
    correct_response: trial.correct_response,
    block_id: trial.block_id,
    block_type: trial.block_type,
    cumulative_score_cent: Math.round(cumulative * 1000) / 10,
  };
}

function sessionInfo(ctx: RuntimeContext) {
  return { ...ctx.meta, taskSource: "TrustGame_SocialNonSocial_08072026.py", cbGroup: getCbGroup(ctx.meta.participantId), parityPolicy: "active-script-08-07" };
}
