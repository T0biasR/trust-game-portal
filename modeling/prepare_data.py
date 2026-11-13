"""Convert a de-identified portal export into CmdStan input.

The script intentionally fails on incomplete runs and unknown schema versions so that
scientific analyses never silently mix incompatible task releases.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

PROFILE = {"low": 1, "neutral": 2, "high": 3}


def build(export: dict) -> dict:
    completed = {
        row["run_id"] for row in export["runs"]
        if row["status"] == "completed" and row.get("quality_status") == "pass"
    }
    by_run: dict[str, list[dict]] = {run_id: [] for run_id in completed}
    for event in export["events"]:
        if event["run_id"] in completed and event["event_type"] == "trial_complete":
            by_run[event["run_id"]].append(event["payload"])

    run_ids = sorted(
        run_id for run_id, rows in by_run.items()
        if sum(r.get("domain") == "trust" for r in rows) == 72
        and any(r.get("domain") == "trust" and not r.get("omitted") for r in rows)
    )
    if not run_ids:
        raise ValueError("No complete 72-trial investor runs found")

    trust: list[dict] = []
    risk: list[dict] = []
    for subject, run_id in enumerate(run_ids, 1):
        rows = sorted(by_run[run_id], key=lambda row: (row.get("domain", ""), row.get("ordinal", 0)))
        for row in rows:
            if row.get("domain") == "trust":
                if row.get("omitted"):
                    continue
                trust.append({"subject": subject, **row})
            elif row.get("domain") == "risk":
                if not row.get("omitted"):
                    risk.append({"subject": subject, **row})

    starts, ends = [], []
    for subject in range(1, len(run_ids) + 1):
        indices = [i + 1 for i, row in enumerate(trust) if row["subject"] == subject]
        starts.append(min(indices)); ends.append(max(indices))

    return {
        "S": len(run_ids),
        "N": len(trust),
        "subj": [r["subject"] for r in trust],
        "start": starts,
        "end": ends,
        "forced": [0 for _ in trust],
        "left": [PROFILE.get(r.get("left_profile"), 2) for r in trust],
        "right": [PROFILE.get(r.get("right_profile"), 2) for r in trust],
        "chosen": [PROFILE.get(r.get("chosen_profile"), 2) for r in trust],
        "chose_right": [1 if r.get("choice_key") == "right" else 0 for r in trust],
        "investment": [float(r["investment"]) for r in trust],
        "feedback_informative": [1 if float(r["investment"]) > 0 else 0 for r in trust],
        "favorable": [1.0 if r.get("outcomeType") == "win" else 0.0 for r in trust],
        "R": len(risk),
        "risk_subj": [r["subject"] for r in risk],
        "sure": [float(r["sure_tokens"]) for r in risk],
        "gain": [float(r["gain_tokens"]) for r in risk],
        "loss": [float(r["loss_tokens"]) for r in risk],
        "p_gain": [float(r["gain_probability"]) for r in risk],
        "chose_gamble": [1 if r["choice"] == "gamble" else 0 for r in risk],
        "run_ids": run_ids,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("export", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    data = build(json.loads(args.export.read_text(encoding="utf-8")))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
