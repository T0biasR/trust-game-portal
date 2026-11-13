functions {
  real signed_utility(real x, real rho, real lambda) {
    return x >= 0 ? pow(x, rho) : -lambda * pow(-x, rho);
  }
}
data {
  int<lower=1> S;
  int<lower=1> N;
  array[N] int<lower=1,upper=S> subj;
  array[S] int<lower=1,upper=N> start;
  array[S] int<lower=1,upper=N> end;
  array[N] int<lower=0,upper=1> forced;
  array[N] int<lower=1,upper=3> left;
  array[N] int<lower=1,upper=3> right;
  array[N] int<lower=1,upper=3> chosen;
  array[N] int<lower=0,upper=1> chose_right;
  array[N] int<lower=0,upper=10> investment;
  array[N] int<lower=0,upper=1> feedback_informative;
  vector<lower=0,upper=1>[N] favorable;
  int<lower=0> R;
  array[R] int<lower=1,upper=S> risk_subj;
  vector[R] sure;
  vector[R] gain;
  vector[R] loss;
  vector<lower=0,upper=1>[R] p_gain;
  array[R] int<lower=0,upper=1> chose_gamble;
}
parameters {
  vector[10] mu;
  vector<lower=0>[10] sigma;
  matrix[S,10] raw;
  matrix[S,3] q0_raw;
  vector[3] q0_mu;
  vector<lower=0>[3] q0_sigma;
}
transformed parameters {
  matrix[S,10] theta;
  matrix<lower=0,upper=1>[S,3] q0;
  for (s in 1:S) {
    for (k in 1:10) theta[s,k] = mu[k] + sigma[k] * raw[s,k];
    for (p in 1:3) q0[s,p] = inv_logit(q0_mu[p] + q0_sigma[p] * q0_raw[s,p]);
  }
}
model {
  mu ~ normal(0, 1);
  sigma ~ normal(0, .7);
  to_vector(raw) ~ std_normal();
  q0_mu ~ normal(0, 1);
  q0_sigma ~ normal(0, .7);
  to_vector(q0_raw) ~ std_normal();

  for (s in 1:S) {
    vector[3] q = to_vector(q0[s]');
    real alpha_pos = inv_logit(theta[s,1]);
    real alpha_neg = inv_logit(theta[s,2]);
    real beta_choice = exp(theta[s,3]);
    real perseveration = theta[s,4];
    real side_bias = theta[s,5];
    real lapse = .2 * inv_logit(theta[s,6]);
    real rho = exp(theta[s,7]);
    real lambda = exp(theta[s,8]);
    real beta_amount = exp(theta[s,9]);
    int previous_choice = 0;
    for (n in start[s]:end[s]) {
      if (forced[n] == 0) {
        real logit_right = beta_choice * (q[right[n]] - q[left[n]]) + side_bias;
        if (previous_choice > 0) logit_right += perseveration * (previous_choice == right[n] ? 1 : -1);
        target += log_mix(lapse, bernoulli_lpmf(chose_right[n] | .5), bernoulli_logit_lpmf(chose_right[n] | logit_right));
      }
      {
        vector[11] amount_value;
        for (a0 in 0:10) {
          real stake = a0 / 10.0;
          amount_value[a0 + 1] = beta_amount * (q[chosen[n]] * signed_utility(stake, rho, lambda) + (1-q[chosen[n]]) * signed_utility(-stake, rho, lambda));
        }
        investment[n] + 1 ~ categorical_logit(amount_value);
      }
      if (feedback_informative[n] == 1) {
        real pe = favorable[n] - q[chosen[n]];
        q[chosen[n]] += (pe >= 0 ? alpha_pos : alpha_neg) * pe;
      }
      previous_choice = chosen[n];
    }
  }
  for (r in 1:R) {
    int s = risk_subj[r];
    real rho = exp(theta[s,7]);
    real lambda = exp(theta[s,8]);
    real beta_risk = exp(theta[s,10]);
    real u_gamble = p_gain[r] * signed_utility(gain[r], rho, lambda) + (1-p_gain[r]) * signed_utility(loss[r], rho, lambda);
    chose_gamble[r] ~ bernoulli_logit(beta_risk * (u_gamble - signed_utility(sure[r], rho, lambda)));
  }
}
generated quantities {
  vector[N + R] log_lik;
  for (i in 1:(N + R)) log_lik[i] = 0;
  for (s in 1:S) {
    vector[3] q = to_vector(q0[s]');
    real alpha_pos = inv_logit(theta[s,1]);
    real alpha_neg = inv_logit(theta[s,2]);
    real beta_choice = exp(theta[s,3]);
    real perseveration = theta[s,4];
    real side_bias = theta[s,5];
    real lapse = .2 * inv_logit(theta[s,6]);
    real rho = exp(theta[s,7]);
    real lambda = exp(theta[s,8]);
    real beta_amount = exp(theta[s,9]);
    int previous_choice = 0;
    for (n in start[s]:end[s]) {
      real trial_ll = 0;
      if (forced[n] == 0) {
        real logit_right = beta_choice * (q[right[n]] - q[left[n]]) + side_bias;
        if (previous_choice > 0) logit_right += perseveration * (previous_choice == right[n] ? 1 : -1);
        trial_ll += log_mix(lapse, bernoulli_lpmf(chose_right[n] | .5), bernoulli_logit_lpmf(chose_right[n] | logit_right));
      }
      {
        vector[11] amount_value;
        for (a0 in 0:10) {
          real stake = a0 / 10.0;
          amount_value[a0 + 1] = beta_amount * (q[chosen[n]] * signed_utility(stake, rho, lambda) + (1-q[chosen[n]]) * signed_utility(-stake, rho, lambda));
        }
        trial_ll += categorical_logit_lpmf(investment[n] + 1 | amount_value);
      }
      log_lik[n] = trial_ll;
      if (feedback_informative[n] == 1) {
        real pe = favorable[n] - q[chosen[n]];
        q[chosen[n]] += (pe >= 0 ? alpha_pos : alpha_neg) * pe;
      }
      previous_choice = chosen[n];
    }
  }
  for (r in 1:R) {
    int s = risk_subj[r];
    real rho = exp(theta[s,7]);
    real lambda = exp(theta[s,8]);
    real beta_risk = exp(theta[s,10]);
    real u_gamble = p_gain[r] * signed_utility(gain[r], rho, lambda) + (1-p_gain[r]) * signed_utility(loss[r], rho, lambda);
    log_lik[N + r] = bernoulli_logit_lpmf(chose_gamble[r] | beta_risk * (u_gamble - signed_utility(sure[r], rho, lambda)));
  }
}
