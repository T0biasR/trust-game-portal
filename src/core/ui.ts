export function clear(el: HTMLElement) {
  el.replaceChildren();
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | null | undefined> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value === null || value === undefined || value === false) return;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else node.setAttribute(key, value === true ? "" : String(value));
  });
  children.forEach((child) => node.append(child instanceof Node ? child : document.createTextNode(child)));
  return node;
}

export async function showMessage(root: HTMLElement, html: string, keys: string[], minMs: number, keyboard: { clear: () => void; consumeAny: (keys: readonly string[]) => string | null }) {
  clear(root);
  root.append(el("div", { class: "center-screen" }, [el("div", { }, [])]));
  const container = root.querySelector(".center-screen > div") as HTMLElement;
  container.innerHTML = html;
  keyboard.clear();
  const start = performance.now();
  while (true) {
    if (performance.now() - start >= minMs && (keys.length === 0 || keyboard.consumeAny(keys))) return;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

export function makeProgress(root: HTMLElement, label: string) {
  clear(root);
  const bar = el("div", { class: "progress" }, [el("div")]);
  const fill = bar.firstElementChild as HTMLElement;
  root.append(el("div", { class: "center-screen" }, [
    el("div", {}, [el("div", { text: label }), bar]),
  ]));
  return (done: number, total: number) => {
    fill.style.width = `${total ? (done / total) * 100 : 0}%`;
  };
}

export async function ensureFullscreen(root: HTMLElement) {
  if (document.fullscreenElement) return;
  clear(root);
  const button = el("button", { class: "primary", text: "Start fullscreen" });
  root.append(el("div", { class: "center-screen" }, [button]));
  await new Promise<void>((resolve) => {
    button.addEventListener("click", async () => {
      await document.documentElement.requestFullscreen();
      resolve();
    }, { once: true });
  });
}

export function getDeviceDiagnostics() {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    hardwareConcurrency: navigator.hardwareConcurrency,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    screenWidth: screen.width,
    screenHeight: screen.height,
    devicePixelRatio: window.devicePixelRatio,
    touchPoints: navigator.maxTouchPoints,
  };
}

export function isDesktopKeyboardLikely() {
  return navigator.maxTouchPoints === 0 && window.innerWidth >= 900 && window.innerHeight >= 600;
}
