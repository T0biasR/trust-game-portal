# Computational modeling

The primary preregistered model is a hierarchical asymmetric Rescorla–Wagner learner. It jointly models free partner choices, investments over 0–10 tokens, and the independent risk/loss calibration. Forced trials update beliefs and enter the investment likelihood but do not enter the partner-choice likelihood.

Candidate models must be evaluated in this order: static/no-learning, one learning rate, asymmetric positive/negative learning rates, and only then a volatility model. Do not use online participant IDs or posterior point estimates as participant-specific fMRI measures; export group posterior draws as informative priors and repeat the fMRI analysis with weak priors.

Usage after installing CmdStan and `requirements.txt`:

```bash
python modeling/prepare_data.py pseudonymous-research-export.json modeling/output/stan-data.json
python modeling/fit.py modeling/output/stan-data.json modeling/output
```

Before production analysis, run simulation-based calibration, parameter recovery, model recovery, and posterior predictive checks under the frozen protocol. The release gate is documented in the root README.
