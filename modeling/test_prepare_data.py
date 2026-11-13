import unittest

from prepare_data import build


def trust_payload(ordinal: int, investment: float = 0.4) -> dict:
    return {
        "domain": "trust", "ordinal": ordinal, "trial_kind": "forced",
        "left_profile": "neutral", "right_profile": None,
        "chosen_profile": "neutral", "choice_key": None,
        "investment": investment, "returned": investment,
        "invested": investment, "outcomeType": "break_even", "omitted": False,
    }


def risk_payload(ordinal: int) -> dict:
    return {
        "domain": "risk", "ordinal": ordinal, "choice": "sure",
        "sure_tokens": 0, "gain_tokens": 4, "loss_tokens": -4,
        "gain_probability": 0.5, "omitted": False,
    }


class PrepareDataTest(unittest.TestCase):
    def test_builds_ordered_joint_model_data_and_excludes_review_runs(self):
        events = []
        for run_id in ["accepted", "review"]:
            events.extend({"run_id": run_id, "event_type": "trial_complete", "payload": trust_payload(i)} for i in range(1, 73))
        export = {
            "runs": [
                {"run_id": "accepted", "status": "completed", "quality_status": "pass"},
                {"run_id": "review", "status": "completed", "quality_status": "review"},
            ],
            "events": events,
        }
        data = build(export)
        self.assertEqual(data["S"], 1)
        self.assertEqual(data["N"], 72)
        self.assertEqual(data["R"], 0)
        self.assertEqual(data["start"], [1])
        self.assertEqual(data["end"], [72])
        self.assertTrue(all(data["feedback_informative"]))

    def test_zero_investment_does_not_update_social_beliefs(self):
        events = [{"run_id": "accepted", "event_type": "trial_complete", "payload": trust_payload(i, 0)} for i in range(1, 73)]
        export = {"runs": [{"run_id": "accepted", "status": "completed", "quality_status": "pass"}], "events": events}
        data = build(export)
        self.assertEqual(data["feedback_informative"], [0] * 72)


if __name__ == "__main__":
    unittest.main()
