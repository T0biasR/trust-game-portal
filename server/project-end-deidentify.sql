-- IRREVERSIBLE PROJECT-END PROCEDURE
-- 1. Stop participant access and create/verify encrypted database backups.
-- 2. Download the de-identified research export and record its SHA-256 checksum.
-- 3. Have two authorized researchers verify the target database and retention date.
-- 4. Run this file once with psql. It removes every access-code/session/consent link
--    while retaining research trials, outcomes, schedules, and completion records.

BEGIN;

ALTER TABLE study_runs DROP CONSTRAINT IF EXISTS study_runs_access_grant_id_fkey;
ALTER TABLE study_runs ALTER COLUMN access_grant_id DROP NOT NULL;
ALTER TABLE study_runs
  ADD CONSTRAINT study_runs_access_grant_id_fkey
  FOREIGN KEY (access_grant_id) REFERENCES access_grants(id) ON DELETE SET NULL;

-- Browser/device fingerprints are operational quality data, not required for
-- the final computational archive.
DELETE FROM trial_events
WHERE event_type IN ('device_check', 'browser_interaction', 'strategy_report');

UPDATE study_runs SET access_grant_id = NULL;
DELETE FROM participant_sessions;
DELETE FROM consents;
DELETE FROM access_grants;

-- Administrator identities may be personal data. Retain the action names and
-- timestamps but replace the actor identifier.
UPDATE admin_audit SET actor = 'redacted-after-project-end';

COMMIT;
