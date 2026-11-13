import type { RuntimeContext, RunPayload, TaskDefinition } from "../core/types";
import { makeProgress, showMessage } from "../core/ui";
import { preloadImages } from "../core/preload";
import settingsJson from "../../Mausland/settings.json";

const spriteUrls = {
  "grass-dry.png": new URL("../../Mausland/sprites/grass-dry.png", import.meta.url).href,
  "grass-lush.png": new URL("../../Mausland/sprites/grass-lush.png", import.meta.url).href,
  "food-0.png": new URL("../../Mausland/sprites/food-0.png", import.meta.url).href,
};
const introUrlsMain = [
  new URL("../../Mausland/introduction/Mausland_Introduction_01.png", import.meta.url).href,
  new URL("../../Mausland/introduction/Mausland_Introduction_02.png", import.meta.url).href,
];

type WorldStateName = "highrisk-highreward" | "highrisk-lowreward" | "lowrisk-highreward" | "lowrisk-lowreward";
type Obj = { id: string; kind: "food" | "enemy"; x: number; y: number; a: number; status: string; exists: boolean; distance: number; speed: number; damage?: number; sight?: number; foodClusterPref?: number };
type World = { state: WorldStateName; size: number; dim: number; bg: string; foodClusters: Array<{ x: number; y: number }>; objects: Obj[]; me: Player };
type Player = { x: number; y: number; a: number; status: string; score: number; frozen: number; viewRadius: number; nFood: number; nDefeats: number; pointsLost: number; distance: number; durations: Record<string, number> };

const ACTIVE_STATES: WorldStateName[] = ["highrisk-highreward", "highrisk-lowreward", "lowrisk-highreward", "lowrisk-lowreward"];
const VIEW_RADIUS = { hide: 110, normal: 195, stand: 380 };

function wrap(v: number, dim: number) {
  return ((v % dim) + dim) % dim;
}

function angleTo(vecX: number, vecY: number) {
  return (Math.atan2(vecX, vecY) * 180 / Math.PI + 360) % 360;
}

function angleDiff(target: number, current: number) {
  let d = target - current;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

function createWorld(ctx: RuntimeContext, state: WorldStateName): World {
  const cfg = (settingsJson as any).worldstates[state];
  const size = Number((settingsJson as any).world.size);
  const dim = 512 * size;
  const clusters = Array.from({ length: cfg.n_foodclusters }, () => ({ x: ctx.rng.next() * dim, y: ctx.rng.next() * dim }));
  const objects: Obj[] = [];
  for (let i = 0; i < cfg.n_enemies; i += 1) {
    objects.push({
      id: `enemy-${String(i + 1).padStart(2, "0")}`,
      kind: "enemy",
      x: 300 + ctx.rng.next() * (dim - 300),
      y: 300 + ctx.rng.next() * (dim - 300),
      a: ctx.rng.next() * 360,
      status: "roam",
      exists: true,
      distance: 0,
      speed: 5,
      damage: cfg.enemy_damage,
      sight: cfg.enemy_sight,
      foodClusterPref: -1,
    });
  }
  for (let i = 0; i < cfg.n_food; i += 1) {
    let x: number;
    let y: number;
    if (clusters.length) {
      const c = ctx.rng.choice(clusters);
      x = wrap(c.x + (ctx.rng.next() - 0.5) * dim / 10, dim);
      y = wrap(c.y + (ctx.rng.next() - 0.5) * dim / 10, dim);
    } else {
      x = ctx.rng.next() * dim;
      y = ctx.rng.next() * dim;
    }
    objects.push({ id: `food-${String(i + 1).padStart(2, "0")}`, kind: "food", x, y, a: 0, status: "visible", exists: true, distance: 0, speed: 0 });
  }
  return {
    state,
    size,
    dim,
    bg: cfg.bg,
    foodClusters: clusters,
    objects,
    me: { x: 0, y: 0, a: ctx.rng.next() * 360, status: "idle", score: 0, frozen: 0, viewRadius: VIEW_RADIUS.normal, nFood: 0, nDefeats: 0, pointsLost: 0, distance: 0, durations: {} },
  };
}

function shortestVector(fromX: number, fromY: number, toX: number, toY: number, dim: number) {
  let dx = fromX - toX;
  let dy = fromY - toY;
  if (Math.abs(dx) > dim / 2) dx -= Math.sign(dx) * dim;
  if (Math.abs(dy) > dim / 2) dy -= Math.sign(dy) * dim;
  return { dx, dy, d: Math.hypot(dx, dy) };
}

function updateWorld(ctx: RuntimeContext, world: World, dtScale: number, logs: { events: Record<string, unknown>[] }, blockIdx: number) {
  const me = world.me;
  const key = (k: string) => ctx.keyboard.isDown(k);
  const prevStatus = me.status;
  let action = "idle";
  if (key("1") && key("4")) action = "stand";
  else if (key("4")) action = "hide";
  else {
    if (key("2")) action = "move";
    if (key("1")) action = "rotl";
    if (key("3")) action = "rotr";
  }
  me.durations[prevStatus] = (me.durations[prevStatus] ?? 0) + dtScale / 18;
  if (me.frozen <= 0) {
    if (action === "move") {
      const dist = 14 * dtScale;
      me.x = wrap(me.x + dist * Math.sin(me.a * Math.PI / 180), world.dim);
      me.y = wrap(me.y - dist * Math.cos(me.a * Math.PI / 180), world.dim);
      me.distance += Math.abs(dist);
    } else if (action === "rotl") me.a = wrap(me.a - 7 * dtScale, 360);
    else if (action === "rotr") me.a = wrap(me.a + 7 * dtScale, 360);
    me.status = action;
    if (action !== prevStatus && action === "stand") logs.events.push(eventRow(ctx, blockIdx, world, "stand_on"));
    if (action !== prevStatus && prevStatus === "stand") logs.events.push(eventRow(ctx, blockIdx, world, "stand_off"));
    if (action !== prevStatus && action === "hide") logs.events.push(eventRow(ctx, blockIdx, world, "hide_on"));
    if (action !== prevStatus && prevStatus === "hide") logs.events.push(eventRow(ctx, blockIdx, world, "hide_off"));
  } else {
    me.frozen -= 1 * dtScale;
  }
  me.viewRadius = me.status === "hide" ? VIEW_RADIUS.hide : me.status === "stand" ? VIEW_RADIUS.stand : VIEW_RADIUS.normal;

  for (const obj of world.objects) {
    if (!obj.exists) continue;
    const vec = shortestVector(obj.x, obj.y, me.x, me.y, world.dim);
    obj.distance = vec.d;
    if (obj.kind === "food") {
      if (vec.d < 30) {
        obj.exists = false;
        obj.status = "eaten";
        me.score += 1;
        me.nFood += 1;
        logs.events.push(eventRow(ctx, blockIdx, world, "eat"));
      }
      continue;
    }
    if (vec.d < 38 && me.frozen <= 0) {
      const penalty = obj.damage ?? 1;
      me.score = Math.max(0, me.score - penalty);
      me.nDefeats += 1;
      me.pointsLost += penalty;
      me.frozen = 10;
      me.status = "defeat";
      logs.events.push(eventRow(ctx, blockIdx, world, "defeat", penalty));
      continue;
    }
    let sight = obj.sight ?? 60;
    if (me.status === "hide") sight /= 2;
    if (me.status === "stand") sight *= 4;
    const diff = angleDiff(angleTo(vec.dx, vec.dy), obj.a);
    if ((Math.abs(diff) < 35 && vec.d < 3 * sight) || (Math.abs(diff) < 100 && vec.d < 2 * sight) || vec.d < sight) {
      obj.status = "hunt";
      obj.speed = ((settingsJson as any).worldstates[world.state].speed_enemy_hunt ?? 16);
      obj.a += Math.sign(diff) * 7 * dtScale;
    } else {
      obj.status = "roam";
      obj.speed = 5;
      obj.a += (ctx.rng.next() - 0.5) * 3 * dtScale;
    }
    obj.x = wrap(obj.x - obj.speed * dtScale * Math.sin(obj.a * Math.PI / 180), world.dim);
    obj.y = wrap(obj.y - obj.speed * dtScale * Math.cos(obj.a * Math.PI / 180), world.dim);
  }
}

function eventRow(ctx: RuntimeContext, blockIdx: number, world: World, event_type: string, extra: unknown = "") {
  return { time_s: ctx.clock.now() / 1000, block_idx: blockIdx, world_state: world.state, event_type, score: world.me.score, x: Math.round(world.me.x), y: Math.round(world.me.y), extra };
}

function blockRow(ctx: RuntimeContext, blockIdx: number, state: string, start: number, end: number, me: Player) {
  return {
    block_idx: blockIdx,
    world_state: state,
    start_s: start / 1000,
    end_s: end / 1000,
    duration_s: (end - start) / 1000,
    n_food_eaten: me.nFood,
    n_defeats: me.nDefeats,
    points_gained: me.nFood,
    points_lost: me.pointsLost,
    score_start: 0,
    score_end: me.score,
    distance_traveled: me.distance,
    duration_idle_s: me.durations.idle ?? 0,
    duration_move_s: me.durations.move ?? 0,
    duration_turn_s: (me.durations.rotl ?? 0) + (me.durations.rotr ?? 0),
    duration_stand_s: me.durations.stand ?? 0,
    duration_hide_s: me.durations.hide ?? 0,
    duration_defeat_s: me.durations.defeat ?? 0,
  };
}

function render(canvas: HTMLCanvasElement, world: World, images: Record<string, HTMLImageElement>) {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, w, h);
  const bg = images[world.bg] ?? null;
  const tile = 96;
  for (let x = -tile; x < w + tile; x += tile) {
    for (let y = -tile; y < h + tile; y += tile) {
      if (bg) ctx.drawImage(bg, x, y, tile, tile);
    }
  }
  const toScreen = (x: number, y: number) => {
    const v = shortestVector(x, y, world.me.x, world.me.y, world.dim);
    return { x: w / 2 + v.dx, y: h / 2 + v.dy, d: v.d };
  };
  for (const obj of world.objects) {
    if (!obj.exists) continue;
    const p = toScreen(obj.x, obj.y);
    if (p.d > Math.max(w, h)) continue;
    if (obj.kind === "food") {
      const img = images["food-0.png"];
      if (img) ctx.drawImage(img, p.x - 16, p.y - 16, 32, 32);
    } else {
      ctx.fillStyle = obj.status === "hunt" ? "#d33" : "#7a5cff";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 18, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  const grad = ctx.createRadialGradient(w / 2, h / 2, 40, w / 2, h / 2, world.me.viewRadius);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  ctx.fillStyle = world.me.status === "hide" ? "#66aaff" : world.me.status === "stand" ? "#ffee66" : "#fff";
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, 20, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "22px Arial";
  ctx.fillText(`x${world.me.score}`, 24, 40);
}

async function loadCanvasImages(urls: Record<string, string>) {
  const images: Record<string, HTMLImageElement> = {};
  await Promise.all(Object.entries(urls).map(([name, url]) => new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.onload = () => { images[name] = img; resolve(); };
    img.onerror = () => reject(new Error(`Failed image ${name}`));
    img.src = url;
  })));
  return images;
}

export const mauslandTask: TaskDefinition = {
  id: "mausland",
  title: "Mausland",
  description: "Browser canvas port of the active Mausland risk/reward foraging game.",
  async run(ctx): Promise<RunPayload> {
    const introUrls = introUrlsMain;
    const progress = makeProgress(ctx.root, "Loading Mausland assets");
    await preloadImages([...Object.values(spriteUrls), ...introUrls], progress);
    const images = await loadCanvasImages(spriteUrls);
    for (const url of introUrls) {
      await showMessage(ctx.root, `<img src="${url}" style="width:100vw;height:100vh;object-fit:contain">`, ["1", "2", "3", "4"], 4000, ctx.keyboard);
    }
    await showMessage(ctx.root, "Wir starten nun mit den Übungsdurchläufen.", ["1", "2", "3", "4"], 3000, ctx.keyboard);
    await runGame(ctx, images, 120000, false);
    await showMessage(ctx.root, "Die Übungsdurchläufe sind beendet.<br><br>Drücken Sie 6, um die Hauptaufgabe zu beginnen.", ["6"], 0, ctx.keyboard);
    const result = await runGame(ctx, images, 420000, true);
    const payload = { session: { ...ctx.meta, taskSource: "mausland2d.py/settings.json" }, schedule: result.schedule, trials: [], events: result.events, blocks: result.blocks, stateLog: result.stateLog, quality: ctx.logger.quality };
    await ctx.logger.finish(payload);
    return payload;
  },
};

async function runGame(ctx: RuntimeContext, images: Record<string, HTMLImageElement>, durationMs: number, logData: boolean) {
  ctx.root.replaceChildren();
  const canvas = document.createElement("canvas");
  canvas.className = "mausland-canvas";
  canvas.width = 1280;
  canvas.height = 720;
  ctx.root.append(canvas);
  ctx.clock.reset();
  let blockIdx = 1;
  let blockStart = 0;
  let currentState = ctx.rng.choice(ACTIVE_STATES);
  let world = createWorld(ctx, currentState);
  const schedule: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const blocks: Record<string, unknown>[] = [];
  const stateLog: Record<string, unknown>[] = [];
  let last = performance.now();
  let lastStateLog = -500;
  const blockMs = 20000;
  while (ctx.clock.now() < durationMs) {
    const now = performance.now();
    const dtScale = Math.min(3, (now - last) / (1000 / 18));
    last = now;
    if (ctx.clock.now() - blockStart >= blockMs) {
      blocks.push(blockRow(ctx, blockIdx, currentState, blockStart, ctx.clock.now(), world.me));
      schedule.push({ block_idx: blockIdx, world_state: currentState, start_s: blockStart / 1000, end_s: ctx.clock.now() / 1000 });
      blockIdx += 1;
      blockStart = ctx.clock.now();
      currentState = ctx.rng.choice(ACTIVE_STATES);
      world = createWorld(ctx, currentState);
    }
    updateWorld(ctx, world, dtScale, { events }, blockIdx);
    render(canvas, world, images);
    if (logData && ctx.clock.now() - lastStateLog >= 500) {
      lastStateLog = ctx.clock.now();
      stateLog.push({ time_s: ctx.clock.now() / 1000, block_idx: blockIdx, world_state: world.state, me_x: Math.round(world.me.x), me_y: Math.round(world.me.y), me_status: world.me.status, score: world.me.score });
    }
    await ctx.clock.sleep(1000 / 60);
  }
  blocks.push(blockRow(ctx, blockIdx, currentState, blockStart, ctx.clock.now(), world.me));
  schedule.push({ block_idx: blockIdx, world_state: currentState, start_s: blockStart / 1000, end_s: ctx.clock.now() / 1000 });
  return { schedule, events: logData ? events : [], blocks: logData ? blocks : [], stateLog: logData ? stateLog : [] };
}
