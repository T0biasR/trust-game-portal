import type { Rng } from "./types";

export function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function createRng(seedText: string): Rng {
  let state = hashSeed(seedText) || 0x9e3779b9;
  const next = () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(minInclusive, maxExclusive) {
      return Math.floor(next() * (maxExclusive - minInclusive)) + minInclusive;
    },
    choice(items) {
      if (items.length === 0) throw new Error("Cannot sample from an empty array");
      return items[Math.floor(next() * items.length)];
    },
    shuffle(items) {
      for (let i = items.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      return items;
    },
  };
}
