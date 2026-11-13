export type TaskId = "hariri-slider" | "trust-game" | "mausland";

export type ParticipantMeta = {
  participantId: string;
  session: string;
  sex: "male" | "female";
  taskId: TaskId;
  seed: string;
  startedAt: string;
};

export type QualityEvent = {
  t: number;
  type: string;
  detail?: string;
};

export type RunPayload = {
  session: Record<string, unknown>;
  schedule: unknown;
  trials: Record<string, unknown>[];
  traces?: Record<string, unknown>[];
  events?: Record<string, unknown>[];
  blocks?: Record<string, unknown>[];
  stateLog?: Record<string, unknown>[];
  quality: QualityEvent[];
};

export type TaskDefinition = {
  id: TaskId;
  title: string;
  description: string;
  run: (ctx: RuntimeContext) => Promise<RunPayload>;
};

export type RuntimeContext = {
  meta: ParticipantMeta;
  root: HTMLElement;
  rng: Rng;
  clock: ExperimentClock;
  keyboard: KeyboardState;
  logger: RunLogger;
  assetBase: string;
};

export type Rng = {
  next: () => number;
  int: (minInclusive: number, maxExclusive: number) => number;
  choice: <T>(items: readonly T[]) => T;
  shuffle: <T>(items: T[]) => T[];
};

export type ExperimentClock = {
  reset: () => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  waitUntil: (targetMs: number, draw?: () => void) => Promise<void>;
  raf: () => Promise<number>;
};

export type KeyboardState = {
  start: () => void;
  stop: () => void;
  clear: () => void;
  isDown: (key: string) => boolean;
  consumeAny: (keys: readonly string[]) => string | null;
  waitFor: (keys: readonly string[]) => Promise<string>;
  snapshot: (keys: readonly string[]) => boolean[];
};

export type RunLogger = {
  quality: QualityEvent[];
  mark: (type: string, detail?: string) => void;
  checkpoint: (payload: Partial<RunPayload>) => Promise<void>;
  finish: (payload: RunPayload) => Promise<void>;
};
