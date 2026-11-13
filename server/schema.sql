CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text UNIQUE NOT NULL,
  study_type text NOT NULL CHECK (study_type IN ('investor', 'trustee', 'workflow')),
  participant_sex text CHECK (participant_sex IN ('male', 'female')),
  counterbalance_group text CHECK (counterbalance_group IN ('CB1', 'CB2', 'CB3', 'CB4')),
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'active', 'completed', 'revoked')),
  protocol_version text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS participant_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_grant_id uuid NOT NULL REFERENCES access_grants(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_grant_id uuid NOT NULL REFERENCES access_grants(id) ON DELETE CASCADE,
  document_version text NOT NULL,
  accepted boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS protocols (
  version text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  configuration jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outcome_banks (
  version text PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('recorded-human', 'simulated-development')),
  content_hash text NOT NULL,
  bank jsonb NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS study_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_grant_id uuid NOT NULL REFERENCES access_grants(id) ON DELETE RESTRICT,
  protocol_version text NOT NULL,
  schema_version text NOT NULL,
  seed text NOT NULL,
  schedule_hash text NOT NULL,
  outcome_bank_version text,
  host text NOT NULL DEFAULT 'portal' CHECK (host IN ('portal', 'jatos', 'pavlovia')),
  host_session_id text,
  deployment_id text,
  client_version text,
  schedule jsonb NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'running', 'completed', 'stopped')),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(access_grant_id)
);

-- Prolific and multi-step workflow metadata. Existing code-based grants remain
-- supported; Prolific grants are created server-side and have no participant-
-- visible access code.
ALTER TABLE access_grants
  ADD COLUMN IF NOT EXISTS participant_sex text,
  ADD COLUMN IF NOT EXISTS counterbalance_group text,
  ADD COLUMN IF NOT EXISTS recruitment_source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS prolific_pid text,
  ADD COLUMN IF NOT EXISTS prolific_study_id text,
  ADD COLUMN IF NOT EXISTS prolific_session_id text,
  ADD COLUMN IF NOT EXISTS gender_identity text,
  ADD COLUMN IF NOT EXISTS face_set_preference text,
  ADD COLUMN IF NOT EXISTS workflow_version_id uuid;
ALTER TABLE access_grants DROP CONSTRAINT IF EXISTS access_grants_study_type_check;
ALTER TABLE access_grants ADD CONSTRAINT access_grants_study_type_check
  CHECK (study_type IN ('investor', 'trustee', 'workflow'));
-- The MRI protocol's canonical counterbalancing artifact defines CB1–CB3.
-- NOT VALID preserves any legacy CB4 rows while enforcing the current design
-- for all newly assigned values.
ALTER TABLE access_grants DROP CONSTRAINT IF EXISTS access_grants_counterbalance_group_check;
ALTER TABLE access_grants ADD CONSTRAINT access_grants_counterbalance_group_check
  CHECK (counterbalance_group IS NULL OR counterbalance_group IN ('CB1', 'CB2', 'CB3')) NOT VALID;

ALTER TABLE study_runs
  ADD COLUMN IF NOT EXISTS workflow_definition_id uuid,
  ADD COLUMN IF NOT EXISTS recruitment_source text NOT NULL DEFAULT 'manual';

ALTER TABLE study_runs DROP CONSTRAINT IF EXISTS study_runs_host_check;
ALTER TABLE study_runs ADD CONSTRAINT study_runs_host_check
  CHECK (host IN ('portal', 'jatos', 'pavlovia', 'github-pages'));

ALTER TABLE access_grants DROP CONSTRAINT IF EXISTS access_grants_recruitment_source_check;
ALTER TABLE access_grants ADD CONSTRAINT access_grants_recruitment_source_check
  CHECK (recruitment_source IN ('manual', 'prolific', 'test'));
ALTER TABLE access_grants DROP CONSTRAINT IF EXISTS access_grants_face_set_preference_check;
ALTER TABLE access_grants ADD CONSTRAINT access_grants_face_set_preference_check
  CHECK (face_set_preference IS NULL OR face_set_preference IN ('male', 'female', 'random'));
CREATE UNIQUE INDEX IF NOT EXISTS access_grants_prolific_session_idx
  ON access_grants(prolific_study_id, prolific_session_id)
  WHERE prolific_study_id IS NOT NULL AND prolific_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS access_grants_recruitment_idx
  ON access_grants(recruitment_source, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  steps jsonb NOT NULL,
  content_hash text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE(name, version)
);

DO $$ BEGIN
  ALTER TABLE access_grants ADD CONSTRAINT access_grants_workflow_definition_fk
    FOREIGN KEY (workflow_version_id) REFERENCES workflow_definitions(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE study_runs ADD CONSTRAINT study_runs_workflow_definition_fk
    FOREIGN KEY (workflow_definition_id) REFERENCES workflow_definitions(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS prolific_studies (
  prolific_study_id text PRIMARY KEY,
  workflow_definition_id uuid NOT NULL REFERENCES workflow_definitions(id),
  completion_url text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_step_states (
  run_id uuid NOT NULL REFERENCES study_runs(id) ON DELETE CASCADE,
  step_id text NOT NULL,
  module_id text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'completed', 'skipped', 'failed')),
  started_at timestamptz,
  completed_at timestamptz,
  response jsonb,
  PRIMARY KEY(run_id, step_id)
);

CREATE TABLE IF NOT EXISTS participant_events (
  id bigserial PRIMARY KEY,
  access_grant_id uuid NOT NULL REFERENCES access_grants(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  client_time_ms double precision,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  server_time timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS participant_events_grant_idx
  ON participant_events(access_grant_id, server_time);

CREATE TABLE IF NOT EXISTS researcher_sessions (
  token_hash text PRIMARY KEY,
  researcher_email text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS firebase_exports (
  run_id uuid PRIMARY KEY REFERENCES study_runs(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'uploading', 'uploaded', 'failed')),
  json_object text,
  tsv_object text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  uploaded_at timestamptz
);

CREATE TABLE IF NOT EXISTS trial_events (
  run_id uuid NOT NULL REFERENCES study_runs(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  trial_id text,
  client_time_ms double precision NOT NULL,
  server_time timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  PRIMARY KEY(run_id, sequence),
  UNIQUE(run_id, event_id)
);

CREATE TABLE IF NOT EXISTS outcome_resolutions (
  run_id uuid NOT NULL REFERENCES study_runs(id) ON DELETE CASCADE,
  trial_id text NOT NULL,
  profile text NOT NULL,
  investment numeric(5,4) NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id, trial_id)
);

CREATE TABLE IF NOT EXISTS risk_resolutions (
  run_id uuid NOT NULL REFERENCES study_runs(id) ON DELETE CASCADE,
  trial_id text NOT NULL,
  choice text NOT NULL CHECK (choice IN ('sure', 'gamble')),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id, trial_id)
);

CREATE TABLE IF NOT EXISTS trustee_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid UNIQUE NOT NULL REFERENCES study_runs(id) ON DELETE RESTRICT,
  returns_by_investment jsonb NOT NULL,
  quality_passed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS completions (
  run_id uuid PRIMARY KEY REFERENCES study_runs(id) ON DELETE RESTRICT,
  completion_code text UNIQUE NOT NULL,
  quality_status text NOT NULL,
  summary jsonb NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bonuses (
  run_id uuid PRIMARY KEY REFERENCES study_runs(id) ON DELETE RESTRICT,
  selected_trial_ids jsonb NOT NULL,
  amount_eur numeric(6,2) NOT NULL CHECK (amount_eur >= 0 AND amount_eur <= 5),
  calculation_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id bigserial PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trial_events_trial_idx ON trial_events(run_id, trial_id);
CREATE INDEX IF NOT EXISTS grants_status_idx ON access_grants(status, expires_at);
ALTER TABLE access_grants ADD COLUMN IF NOT EXISTS participant_sex text;
ALTER TABLE access_grants ADD COLUMN IF NOT EXISTS counterbalance_group text;
ALTER TABLE study_runs ADD COLUMN IF NOT EXISTS host text NOT NULL DEFAULT 'portal';
ALTER TABLE study_runs ADD COLUMN IF NOT EXISTS host_session_id text;
ALTER TABLE study_runs ADD COLUMN IF NOT EXISTS deployment_id text;
ALTER TABLE study_runs ADD COLUMN IF NOT EXISTS client_version text;

-- Preserve compatibility with databases created before the continuous EUR scale.
ALTER TABLE outcome_resolutions ALTER COLUMN investment TYPE numeric(5,4)
  USING investment::numeric;
