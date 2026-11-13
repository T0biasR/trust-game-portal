# Trust Game online protocol and analysis contract

This document is the scientific contract for `trust-online-v1.0.0`. Any change to instructions, timing, schedules, outcomes, data fields, quality rules, or bonus calculation requires a new protocol version and a new preregistration decision.

## Relationship to the current MRI task

The current MRI reference is `2026-09-16_Trust_Game/TrustGame_Block_10072026.py` with configuration versions `task_structure` 1.4 and `paradigm_outcomes` 1.2. It uses six iterations of three randomized 22-second blocks: four face/reward trials, four face/punishment trials, and four object fact-learning trials, followed by a 22-second baseline. It also includes pre/post face trust ratings. Choice and stake are encoded together by a continuous −1…+1 slider: sign selects the left/right stimulus and magnitude is a €0–€1 stake. Reward outcomes are win/break-even and punishment outcomes are break-even/loss, with high/neutral/low probabilities of .75/.50/.25 (or their loss complement).

The online protocol is deliberately a parameter-estimation companion, not a trial-for-trial browser replica. It retains three counterbalanced social identities, repeated social learning, variable investment, positive and negative net outcomes, and pre/post trust ratings. It separates partner choice from investment amount, adds forced sampling so learning is estimable independently of active choice, adds a nonsocial risk/loss calibration, and replaces programmed partner probabilities with versioned recorded-human decisions. These changes were made for reliable online inference and real interpersonal consequences; they must be represented by an online-specific observation model.

It does not emulate scanner mechanics. MRI triggers, dummy scans, button boxes, scanner operator dialogs, pulse synchronization, fixed 22-second baselines, and scanner file naming are absent. Participants use arrow keys and Enter on a desktop/laptop keyboard.

MRI timing cannot be inferred from browser presentation timestamps. The online study is for behavioral estimation and group-prior construction; the fMRI implementation must retain scanner-synchronized onset logging separately.

## Participant flow

1. A one-time pseudonymous code creates a 12-hour secure session.
2. The ethics-approved, versioned consent is recorded.
3. The portal displays Trust Game, Hariri Face Matching, and Mausland. Only Trust Game is enabled in this release.
4. A device check requires a keyboard and a window of at least 900 × 600 pixels.
5. Participants read a worked payoff example and must pass three comprehension questions within three attempts.
6. Baseline ratings are recorded for the three counterbalanced faces.
7. Participants complete 24 nonsocial risk-calibration decisions.
8. Participants complete 96 Trust Game trials in four blocks.
9. Post-task ratings, a strategy report, and an attention/seriousness item are recorded.
10. The server verifies completeness, computes the bonus, freezes the run, and returns a completion code.

## Trust schedule

Each participant receives a server-generated seeded schedule. The seed and schedule hash are stored. Every one of four blocks contains:

- two forced trials for each of low, neutral, and high reciprocity partners (six forced trials);
- six free-choice trials for each partner pair (18 choice trials);
- independently counterbalanced left/right positions;
- a deterministic, seeded 400–800 ms fixation interval.

This yields 24 forced trials and 72 free choices. Forced trials identify learning about partners independently of active sampling; free trials identify partner choice. Face identity is randomly mapped to latent partner profile, and male/female face sets are balanced by schedule seed.

Every round starts with 10 points. An investment from 0 to 10 is tripled. The selected recorded trustee policy determines the return. Participant payoff is `10 - investment + return`; net benefit relative to keeping the endowment is `return - investment`.

## Recorded-human outcome bank

The production investor task cannot start with simulated returns. Trustee participants first complete the strategy method: return decisions for all possible investments from 0 through 10. Trustee choices are initially unapproved. A researcher reviews response times, completeness, the return vector, comprehension, and preregistered exclusion criteria, then explicitly accepts or rejects each profile.

At least nine accepted policies are required. Accepted trustees are ranked by mean proportion returned, split into low/neutral/high terciles, and stored in an immutable versioned bank with a content hash. Each investor run stores the exact bank version. The development-only simulated bank is visually marked and the production server rejects it.

## Event-level data contract

The browser assigns a UUID and monotonic run-local sequence to every event, saves unsent events locally, and retries idempotently. The server adds receipt time and never trusts the browser to calculate outcomes or bonuses.

Trust trial records contain:

- protocol trial ID, ordinal, block, forced/free condition, offered profiles, and left/right position;
- face-to-profile assignment and chosen latent profile;
- raw choice key, choice RT, investment, investment RT, confirmation state, and all keyboard transitions;
- server-resolved investment, tripled amount, return, payoff, net payoff, and recorded trustee-policy ID;
- planned fixation, total browser duration, omission flag, and omission phase.

Risk records contain both options, gain probability, spatial placement, chosen option/key, response RT captured before the network request, realized outcome, and server random draw. Quality events contain device/browser diagnostics, comprehension attempts, window-focus changes, ratings, omissions, strategy text, and seriousness confirmation. Potentially identifying free text and device/browser events are deleted by the project-end de-identification procedure.

## Computational model

The implemented primary model is a hierarchical asymmetric Rescorla–Wagner learner. Partner beliefs are updated on informative trials, including forced trials. Zero investments produce no observable reciprocity and therefore do not update social beliefs. Free partner choices use learned value difference, side bias, choice perseveration, lapse, and choice temperature. Investment amounts are modeled jointly across all eleven integer amounts. Nonsocial calibration jointly identifies risk curvature, loss aversion, and risk-choice temperature.

The preregistered comparison sequence should be:

1. static/no-learning model;
2. single learning-rate model;
3. asymmetric positive/negative learning rates;
4. only if recovery supports it, a volatility learner.

Model selection must use pointwise log likelihood, predictive performance, parameter recovery, model recovery, simulation-based calibration, and posterior predictive checks—not fit indices alone. The Stan model emits valid pointwise likelihood values for Trust and risk decisions.

The online posterior is not a substitute for an fMRI participant estimate. Only shared latent constructs—positive/negative updating, value sensitivity, choice consistency, risk curvature, and loss aversion—are candidates for transfer. Export hyperparameter draws as group-level informative priors for the independent fMRI sample, fit an MRI-specific observation model for its signed continuous slider and reward/punishment blocks, repeat the fMRI analysis with weak priors, and report sensitivity. Online-only parameters such as forced/free sampling or discrete-amount temperature must not be copied blindly. Trialwise fMRI regressors should include chosen partner value, unchosen value/value difference at choice onset, condition-specific prediction error at feedback, signed slider choice, investment magnitude, outcome valence, and utility. Scanner event onsets must come from the scanner-synchronized fMRI task.

## Quality and release gates

Runs are accepted automatically only when all decisions and outcomes reached the server, comprehension was passed, no trial was omitted, and seriousness was confirmed. Other completed runs are marked `review`, retained, and excluded by default from the modeling preparation script; exclusion decisions must still follow the preregistration.

Before launch: replace consent text, verify face-stimulus rights and ethics approval, activate a reviewed recorded-human bank, freeze bonus conversion and recruitment targets, test supported browser/OS combinations, run accessibility/usability pilots, run model/parameter recovery, security-test the OIDC proxy and database, verify backups/restoration, and document the email-to-code list’s separate controller and deletion date.
