import type { KeyboardState } from "./types";

export function createKeyboard(): KeyboardState {
  const down = new Set<string>();
  const pressed: string[] = [];

  const normalize = (key: string) => (key === " " ? "space" : key.toLowerCase());
  const onKeyDown = (event: KeyboardEvent) => {
    const key = normalize(event.key);
    down.add(key);
    pressed.push(key);
    if (["1", "2", "3", "4", "6", "arrowup", "arrowdown", "arrowleft", "arrowright", "space"].includes(key)) {
      event.preventDefault();
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    down.delete(normalize(event.key));
  };

  return {
    start() {
      window.addEventListener("keydown", onKeyDown, { passive: false });
      window.addEventListener("keyup", onKeyUp);
    },
    stop() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      down.clear();
      pressed.length = 0;
    },
    clear() {
      pressed.length = 0;
    },
    isDown(key) {
      return down.has(normalize(key));
    },
    consumeAny(keys) {
      const wanted = new Set(keys.map(normalize));
      const idx = pressed.findIndex((k) => wanted.has(k));
      if (idx < 0) return null;
      const [key] = pressed.splice(idx, 1);
      return key;
    },
    waitFor(keys) {
      const wanted = new Set(keys.map(normalize));
      return new Promise((resolve) => {
        const handler = (event: KeyboardEvent) => {
          const key = normalize(event.key);
          if (wanted.has(key)) {
            event.preventDefault();
            window.removeEventListener("keydown", handler);
            resolve(key);
          }
        };
        window.addEventListener("keydown", handler, { passive: false });
      });
    },
    snapshot(keys) {
      return keys.map((key) => down.has(normalize(key)));
    },
  };
}
