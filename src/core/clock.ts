import type { ExperimentClock } from "./types";

export function createClock(): ExperimentClock {
  let t0 = performance.now();
  return {
    reset() {
      t0 = performance.now();
    },
    now() {
      return performance.now() - t0;
    },
    sleep(ms) {
      return new Promise((resolve) => window.setTimeout(resolve, ms));
    },
    raf() {
      return new Promise((resolve) => requestAnimationFrame(resolve));
    },
    async waitUntil(targetMs, draw) {
      while (performance.now() - t0 < targetMs) {
        if (draw) draw();
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    },
  };
}
