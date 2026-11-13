"""Fit the preregistered hierarchical model and emit reusable group-prior draws."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import arviz as az
from cmdstanpy import CmdStanModel


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("data", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    model = CmdStanModel(stan_file=str(Path(__file__).parent / "stan" / "asymmetric_rw.stan"))
    fit = model.sample(data=str(args.data), chains=4, parallel_chains=4, iter_warmup=1500, iter_sampling=1500, seed=26072026, adapt_delta=0.95)
    fit.save_csvfiles(dir=str(args.output / "draws"))
    inference = az.from_cmdstanpy(posterior=fit)
    inference.to_netcdf(args.output / "posterior.nc")
    summary = az.summary(inference, var_names=["mu", "sigma"], round_to=5)
    summary.to_csv(args.output / "summary.csv")
    draws = fit.draws_pd(vars=["mu", "sigma"])
    prior_package = {
        "model": "hierarchical-asymmetric-rw-v1",
        "parameter_order": ["alpha_positive", "alpha_negative", "choice_temperature", "perseveration", "side_bias", "lapse", "risk_curvature", "loss_aversion", "amount_temperature", "risk_temperature"],
        "n_draws": len(draws),
        "draws": draws.to_dict(orient="records"),
    }
    (args.output / "fmri-group-priors.json").write_text(json.dumps(prior_package), encoding="utf-8")


if __name__ == "__main__":
    main()
