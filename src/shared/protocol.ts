export const PROTOCOL_VERSION = "trust-online-v2.1.0";
export const DATA_SCHEMA_VERSION = "1.0.0";

export type PartnerProfile = "low" | "neutral" | "high";
export type FaceId = "face_01" | "face_02" | "face_03";
export type CounterbalanceGroup = "CB1" | "CB2" | "CB3";

export function nextLeastUsedCounterbalanceGroup(
  counts: Partial<Record<CounterbalanceGroup, number>>,
): CounterbalanceGroup {
  return (["CB1", "CB2", "CB3"] as const).reduce((least, candidate) =>
    (counts[candidate] ?? 0) < (counts[least] ?? 0) ? candidate : least,
  "CB1");
}

export type TrustTrialSpec = {
  trialId: string;
  ordinal: number;
  block: number;
  kind: "forced" | "choice";
  offeredProfiles: PartnerProfile[];
  faceByProfile: Record<PartnerProfile, FaceId>;
  leftProfile: PartnerProfile | null;
  rightProfile: PartnerProfile | null;
  fixationMs: number;
  trialType?: "face_reward" | "face_punishment" | "learning_object";
  condition?: "reward" | "punishment" | "learning";
  stimulusType?: "face" | "object";
  objectLeft?: string | null;
  objectRight?: string | null;
  question?: string | null;
  fact?: string | null;
  correctSide?: "left" | "right" | null;
  domain?: "object_material" | "object_origin" | null;
};

export type RiskTrialSpec = {
  trialId: string;
  ordinal: number;
  sureTokens: number;
  gainTokens: number;
  lossTokens: number;
  gainProbability: number;
  leftIsGamble: boolean;
};

export type TrustSchedule = {
  protocolVersion: string;
  seed: string;
  faceSet: "f" | "m";
  faceByProfile: Record<PartnerProfile, FaceId>;
  cbGroup: "CB1" | "CB2" | "CB3";
  riskTrials: RiskTrialSpec[];
  trustTrials: TrustTrialSpec[];
};

export type TrusteePolicy = {
  policyId: string;
  returnsByInvestment: number[];
  qualityPassed: boolean;
};

export type OutcomeBank = {
  version: string;
  source: "recorded-human" | "simulated-development";
  createdAt: string;
  profiles: Record<PartnerProfile, TrusteePolicy[]>;
};

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rngFor(seed: string) {
  let state = hashSeed(seed) || 0x9e3779b9;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffle = <T>(items: T[]) => {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  };
  return { next, shuffle };
}

const PROFILES: PartnerProfile[] = ["low", "neutral", "high"];
const FACES: FaceId[] = ["face_01", "face_02", "face_03"];

export function createTrustSchedule(
  seed: string,
  options: { sex?: "male" | "female"; cbGroup?: "CB1" | "CB2" | "CB3" } = {},
): TrustSchedule {
  const rng = rngFor(seed);
  const cbGroups = ["CB1", "CB2", "CB3"] as const;
  const cbGroup = options.cbGroup ?? cbGroups[hashSeed(seed) % cbGroups.length];
  const faceByProfile = ({
    CB1: { high: "face_01", low: "face_02", neutral: "face_03" },
    CB2: { high: "face_03", low: "face_01", neutral: "face_02" },
    CB3: { high: "face_02", low: "face_03", neutral: "face_01" },
  } as const)[cbGroup] as Record<PartnerProfile, FaceId>;
  const faceSet = options.sex === "female" ? "f" : options.sex === "male" ? "m" : rng.next() < 0.5 ? "f" : "m";

  const riskTemplates = [
    [-2, 2, 0.5],
    [-3, 3, 0.5],
    [-4, 4, 0.5],
    [-2, 4, 0.4],
    [-4, 2, 0.6],
    [-5, 5, 0.5],
    [-3, 6, 0.4],
    [-6, 3, 0.6],
  ] as const;
  // The block MRI version has no separate risk-calibration task.
  const riskTrials: RiskTrialSpec[] = [];

  const trustTrials: TrustTrialSpec[] = [];
  const pairs: PartnerProfile[][] = [
    ["low", "neutral"],
    ["low", "high"],
    ["neutral", "high"],
  ];
  const objects = ["obj_01", "obj_02", "obj_03"];
  const objectFacts: Record<string, Record<string, string>> = {
    object_material: { obj_01: "Ist aus Holz.", obj_02: "Ist aus Metall.", obj_03: "Ist aus Glas." },
    object_origin: { obj_01: "Kommt aus Japan.", obj_02: "Kommt aus Brasilien.", obj_03: "Kommt aus Kanada." },
  };
  const objectQuestions: Record<string, Record<string, string>> = {
    object_material: { obj_01: "Welches Objekt ist aus Holz?", obj_02: "Welches Objekt ist aus Metall?", obj_03: "Welches Objekt ist aus Glas?" },
    object_origin: { obj_01: "Welches Objekt kommt aus Japan?", obj_02: "Welches Objekt kommt aus Brasilien?", obj_03: "Welches Objekt kommt aus Kanada?" },
  };
  const learningPool: Array<{ target: string; foil: string; domain: "object_material" | "object_origin" }> = [];
  for (let repeat = 0; repeat < 2; repeat += 1) {
    for (const domain of ["object_material", "object_origin"] as const) {
      for (const target of objects) {
        for (const foil of objects) if (foil !== target) learningPool.push({ target, foil, domain });
      }
    }
  }
  rng.shuffle(learningPool);
  for (let iteration = 1; iteration <= 6; iteration += 1) {
    const reward = Array.from({ length: 4 }, () => makeFace("reward"));
    const punishment = Array.from({ length: 4 }, () => makeFace("punishment"));
    const learning = learningPool.slice((iteration - 1) * 4, iteration * 4).map(({ target, foil, domain }) => {
      const left = rng.next() < 0.5;
      return {
        trialType: "learning_object" as const,
        condition: "learning" as const,
        stimulusType: "object" as const,
        objectLeft: left ? target : foil,
        objectRight: left ? foil : target,
        correctSide: left ? ("left" as const) : ("right" as const),
        question: objectQuestions[domain][target],
        fact: objectFacts[domain][target],
        domain,
        kind: "choice" as const,
        offeredProfiles: [] as PartnerProfile[],
        leftProfile: null,
        rightProfile: null,
      };
    });
    rng.shuffle([reward, punishment, learning]).forEach((blockTrials) => {
      blockTrials.forEach((trial) => {
        const ordinal = trustTrials.length + 1;
        trustTrials.push({
          trialId: `trust-${String(ordinal).padStart(3, "0")}`,
          ordinal,
          block: iteration,
          kind: trial.kind,
          offeredProfiles: trial.offeredProfiles,
          faceByProfile,
          leftProfile: trial.leftProfile,
          rightProfile: trial.rightProfile,
          fixationMs: 500,
          trialType: trial.trialType,
          condition: trial.condition,
          stimulusType: trial.stimulusType,
          objectLeft: trial.objectLeft ?? null,
          objectRight: trial.objectRight ?? null,
          question: trial.question ?? null,
          fact: trial.fact ?? null,
          correctSide: trial.correctSide ?? null,
          domain: (trial as { domain?: TrustTrialSpec["domain"] }).domain ?? null,
        });
      });
    });
  }

  function makeFace(condition: "reward" | "punishment") {
    const pair = pairs[Math.floor(rng.next() * pairs.length)];
    const shown = rng.next() < 0.5 ? pair : pair.slice().reverse();
    return {
      trialType:
        condition === "reward"
          ? ("face_reward" as const)
          : ("face_punishment" as const),
      condition,
      stimulusType: "face" as const,
      kind: "choice" as const,
      offeredProfiles: shown.slice() as PartnerProfile[],
      leftProfile: shown[0],
      rightProfile: shown[1],
      objectLeft: null,
      objectRight: null,
      question: null,
      fact: null,
      correctSide: null,
    };
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    seed,
    faceSet,
    faceByProfile,
    cbGroup,
    riskTrials,
    trustTrials,
  };
}

export function validateSchedule(schedule: TrustSchedule): string[] {
  const errors: string[] = [];
  if (schedule.riskTrials.length !== 0)
    errors.push("Block schedule must not contain separate risk trials");
  if (schedule.trustTrials.length !== 72)
    errors.push("Block schedule must contain 72 active trials");
  for (let block = 1; block <= 6; block += 1) {
    const trials = schedule.trustTrials.filter(
      (trial) => trial.block === block,
    );
    if (trials.length !== 12)
      errors.push(`Iteration ${block} must contain 12 trials`);
    if (trials.filter((t) => t.trialType === "face_reward").length !== 4)
      errors.push(`Iteration ${block} must contain four reward trials`);
    if (trials.filter((t) => t.trialType === "face_punishment").length !== 4)
      errors.push(`Iteration ${block} must contain four punishment trials`);
    if (trials.filter((t) => t.trialType === "learning_object").length !== 4)
      errors.push(`Iteration ${block} must contain four learning trials`);
    const chunks = [0, 1, 2].map((i) => trials.slice(i * 4, i * 4 + 4));
    if (chunks.some((chunk) => chunk.length !== 4 || new Set(chunk.map((t) => t.trialType)).size !== 1))
      errors.push(`Iteration ${block} must keep each trial type in a contiguous four-trial block`);
  }
  const learning = schedule.trustTrials.filter((t) => t.trialType === "learning_object");
  if (learning.filter((t) => t.domain === "object_material").length !== 12)
    errors.push("Object learning must contain 12 material trials");
  if (learning.filter((t) => t.domain === "object_origin").length !== 12)
    errors.push("Object learning must contain 12 origin trials");
  return errors;
}

function keyPair(profiles: PartnerProfile[]) {
  return profiles.slice().sort().join("|");
}

function pairsKeyed() {
  return [
    ["low", "neutral"],
    ["low", "high"],
    ["neutral", "high"],
  ].map((pair) => pair.sort().join("|"));
}

export function resolveOutcome(
  bank: OutcomeBank,
  profile: PartnerProfile,
  ordinal: number,
  investment: number,
) {
  const policies = bank.profiles[profile].filter(
    (policy) => policy.qualityPassed,
  );
  if (!policies.length)
    throw new Error(`Outcome bank has no valid ${profile} policies`);
  const policy = policies[(ordinal - 1) % policies.length];
  const safeInvestment = Math.max(0, Math.min(10, Math.round(investment)));
  const returned = Math.max(
    0,
    Math.min(
      safeInvestment * 3,
      Number(policy.returnsByInvestment[safeInvestment] ?? 0),
    ),
  );
  return {
    policyId: policy.policyId,
    invested: safeInvestment,
    tripled: safeInvestment * 3,
    returned,
    payoff: 10 - safeInvestment + returned,
    net: returned - safeInvestment,
  };
}

export function makeDevelopmentBank(): OutcomeBank {
  const rates: Record<PartnerProfile, number> = {
    low: 0.2,
    neutral: 0.5,
    high: 0.8,
  };
  const profiles = Object.fromEntries(
    PROFILES.map((profile) => [
      profile,
      Array.from({ length: 3 }, (_, p) => ({
        policyId: `development-${profile}-${p + 1}`,
        qualityPassed: true,
        returnsByInvestment: Array.from({ length: 11 }, (_, investment) => {
          if (investment === 0) return 0;
          const threshold = ((investment * 37 + p * 19) % 100) / 100;
          return threshold < rates[profile] ? investment * 2 : 0;
        }),
      })),
    ]),
  ) as Record<PartnerProfile, TrusteePolicy[]>;
  return {
    version: "development-only-v1",
    source: "simulated-development",
    createdAt: new Date(0).toISOString(),
    profiles,
  };
}

export function buildRecordedBank(
  policies: TrusteePolicy[],
  version: string,
): OutcomeBank {
  const valid = policies.filter(
    (policy) =>
      policy.qualityPassed && policy.returnsByInvestment.length === 11,
  );
  if (valid.length < 9)
    throw new Error(
      "At least nine quality-passed trustee policies are required",
    );
  const score = (policy: TrusteePolicy) =>
    policy.returnsByInvestment
      .slice(1)
      .reduce((sum, value, i) => sum + value / ((i + 1) * 3), 0) / 10;
  const ranked = valid.slice().sort((a, b) => score(a) - score(b));
  const third = Math.floor(ranked.length / 3);
  return {
    version,
    source: "recorded-human",
    createdAt: new Date().toISOString(),
    profiles: {
      low: ranked.slice(0, third),
      neutral: ranked.slice(third, ranked.length - third),
      high: ranked.slice(ranked.length - third),
    },
  };
}
