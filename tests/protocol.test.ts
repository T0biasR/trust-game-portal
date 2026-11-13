import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRecordedBank,
  createTrustSchedule,
  makeDevelopmentBank,
  resolveOutcome,
  validateSchedule,
  nextLeastUsedCounterbalanceGroup,
} from "../src/shared/protocol";

test("schedule invariants hold across 10,000 seeds", () => {
  for (let i = 0; i < 10_000; i += 1) {
    const schedule = createTrustSchedule(`participant-${i}`);
    assert.deepEqual(validateSchedule(schedule), []);
    assert.equal(
      new Set(schedule.trustTrials.map((trial) => trial.trialId)).size,
      72,
    );
    assert.equal(
      schedule.trustTrials.filter((trial) => trial.trialType === "face_reward")
        .length,
      24,
    );
    assert.equal(
      schedule.trustTrials.filter(
        (trial) => trial.trialType === "face_punishment",
      ).length,
      24,
    );
    assert.ok(schedule.trustTrials.every((trial) => trial.fixationMs === 500));
  }
});

test("same seed produces the same schedule", () => {
  assert.deepEqual(
    createTrustSchedule("stable-seed"),
    createTrustSchedule("stable-seed"),
  );
});

test("least-used MRI counterbalancing remains balanced under sequential Prolific entry", () => {
  const counts: Record<"CB1" | "CB2" | "CB3", number> = { CB1: 0, CB2: 0, CB3: 0 };
  for (let participant = 0; participant < 120; participant += 1) {
    const group = nextLeastUsedCounterbalanceGroup(counts);
    counts[group] += 1;
  }
  assert.deepEqual(counts, { CB1: 40, CB2: 40, CB3: 40 });
  assert.equal(nextLeastUsedCounterbalanceGroup({ CB1: 2, CB2: 1, CB3: 2 }), "CB2");
});

test("outcomes are bounded and deterministic", () => {
  const bank = makeDevelopmentBank();
  for (const profile of ["low", "neutral", "high"] as const) {
    for (let trial = 1; trial <= 96; trial += 1) {
      for (let investment = 0; investment <= 10; investment += 1) {
        const a = resolveOutcome(bank, profile, trial, investment);
        const b = resolveOutcome(bank, profile, trial, investment);
        assert.deepEqual(a, b);
        assert.ok(a.returned >= 0 && a.returned <= investment * 3);
        assert.equal(a.payoff, 10 - investment + a.returned);
      }
    }
  }
});

test("recorded bank requires nine valid policies and splits them into profiles", () => {
  const policies = Array.from({ length: 9 }, (_, i) => ({
    policyId: `policy-${i}`,
    qualityPassed: true,
    returnsByInvestment: Array.from({ length: 11 }, (_, investment) =>
      Math.min(investment * 3, Math.round((investment * i) / 4)),
    ),
  }));
  const bank = buildRecordedBank(policies, "recorded-test-v1");
  assert.equal(bank.source, "recorded-human");
  assert.equal(bank.profiles.low.length, 3);
  assert.equal(bank.profiles.neutral.length, 3);
  assert.equal(bank.profiles.high.length, 3);
  assert.throws(() => buildRecordedBank(policies.slice(0, 8), "too-small"));
});
