# Prolific + GitHub Pages + Cloud Run deployment

This is an implementation/operations checklist, not authorization to collect data. Keep the Prolific mapping inactive until the local and staging acceptance checklist is signed off and the University data-protection / ethics reviewers approve the exact deployment, consent text, and Prolific-ID handling.

## Current division of responsibilities

- GitHub Pages serves the static React/Vite participant interface. It has no database credentials and cannot write research data directly.
- The Cloud Run API (Fastify) validates the Prolific study/session, creates the pseudonymous internal run, enforces the workflow and completion criteria, and is the only application component allowed to write research data.
- Cloud SQL for PostgreSQL is the authoritative transactional store and retry queue.
- A Cloud Run service account uses Application Default Credentials to copy completed per-participant JSON and TSV exports into a private Firebase Storage bucket. Browser users and anonymous Firebase clients receive no Storage access.
- The researcher interface uses Firebase Authentication accounts and requires email verification, allow-listed accounts, and TOTP MFA. Keep researcher account creation restricted to administrators.

## 1. GitHub Pages

1. Push this repository to a private University-approved GitHub repository. Do not commit `.env`, service-account credentials, participant exports, Firebase rules that grant public access, or production database snapshots.
2. In repository Settings → Pages, select GitHub Actions as the deployment source.
3. Add repository/environment variables (not secrets; these are public build-time values):
   - `STUDY_API_ORIGIN`: the HTTPS Cloud Run API origin, without a trailing slash.
   - `PAGES_BASE_PATH`: `/` for a custom domain or user-site; otherwise `/<repository-name>/`.
   - `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_APP_ID`, `FIREBASE_PROJECT_ID`: Firebase Web App public configuration used only for named researcher login.
4. Enable Actions and push to `main`, or run “Deploy participant portal” manually. Inspect the action build log and then test the resulting Pages URL. The API origin must be configured before building; GitHub Pages cannot proxy `/api` to Cloud Run.
5. In Firebase Authentication, add the exact Pages hostname to its authorized domains. Use a University-owned custom domain if policy permits; otherwise the GitHub-hosted URL remains visible to participants and to GitHub's hosting infrastructure.
6. Test direct Prolific entry with a Prolific preview URL. Confirm the three parameters arrive, the browser URL is cleaned after entry, refresh resumes the same session, and no access code is shown.

The generated public client config is not a secret. Firebase Storage bucket credentials, service-account keys, database passwords, and API signing/pepper values are secrets and must never be Vite variables or GitHub build variables.

## 2. Google Cloud backend

Provision resources in a University-approved EU region and project:

1. Create a Cloud Run service account with least-privilege access to Cloud SQL and the private Firebase Storage bucket. Do not download a JSON key; Cloud Run uses its attached identity.
2. Create a private Cloud SQL for PostgreSQL instance, database, and restricted application user. Enable automated backups, point-in-time recovery if approved, and a documented retention period. Do not expose the database publicly.
3. Create a private Firebase Storage bucket in the approved region. Enforce uniform bucket-level access, public access prevention, restrictive IAM, lifecycle/retention policy, and audit logging. Firebase Storage requires a billable project configuration; estimate and monitor costs before enabling participant collection.
4. Deploy the API container from the repository's `Dockerfile`. Attach the service account and Cloud SQL instance; set `DATABASE_URL` through Secret Manager using the Cloud SQL socket/connector arrangement appropriate to the chosen deployment. The current local Compose URL is not a production connection string.
5. Set required runtime environment/secrets: `NODE_ENV=production`, `CODE_PEPPER`, `OIDC_PROXY_SECRET` (random, at least 32 characters; retain even when Firebase MFA is used), `DATABASE_URL`, `CONSENT_RELEASED=false` until authorized, `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET`, `RESEARCHER_ACCOUNT_EMAILS`, and `STUDY_ALLOWED_ORIGINS` containing only the exact GitHub Pages origin (scheme + hostname, no path). Configure Cloud Run ingress, concurrency, max instances, health check, request logging policy, and scaling intentionally.
6. Configure HTTPS custom domain if available. Test `/api/health`; then run smoke tests with synthetic records only. Verify DB migration, CORS/preflight from Pages, participant session resume, server-side completion checks, archive retry, private bucket object access, and admin download audit logs.
7. Enable email/password sign-in and TOTP MFA in Firebase Authentication. Create named researcher identities, require verified email and MFA enrollment, set the server allow-list, and test successful MFA plus rejection of non-allow-listed/no-MFA accounts. Enable account recovery and an offboarding procedure.
8. Keep the Prolific study mapping inactive while configuring its Study ID, published workflow version, and Prolific completion URL. Run Preview and a controlled end-to-end test; confirm a completed workflow redirects to the exact Prolific completion URL and an incomplete run cannot.

Do not set `CONSENT_RELEASED=true` or activate a study until institutional review has approved the consent version, the direct Prolific identifier processing/linkage, the hosting provider/subprocessors, region, retention/deletion process, and the participant-facing disclosure. GitHub Pages access logs may include network identifiers; this frontend cannot suppress provider-side logging.

## 3. Workflow and data semantics

Each deployment of the static frontend is versioned independently from the API. Each published workflow stores a version, ordered module IDs, required flags, and content hash. Changing a workflow requires creating and publishing another immutable version. API entry binds one Prolific `(study ID, session ID)` to one participant PID and internal access-grant UUID; the task session token is opaque and stored server-side as a digest.

For Prolific collection, the participant PID, study ID, and session ID are retained in PostgreSQL alongside the internal grant/run linkage so that completion/recruitment can be reconciled. Consequently the study is pseudonymous, not anonymous. The admin export flags this linkage. Export access must be restricted and the linkage deletion/retention schedule documented. Never describe this as anonymous unless the linkage has actually been removed and no other identifying metadata remains.

Completed Prolific runs enqueue a JSON and TSV archive. The PostgreSQL records remain the source of truth; Firebase is an archive/delivery copy. The outbox retries transient upload failures. Admin file download falls back to a fresh PostgreSQL-generated export if Firebase is not configured or the archive has not uploaded.

At this stage only the Trust Game is enabled as an experimental workflow module. Hariri and Mausland are intentionally blocked until their own schedules, event schemas, resume behavior, scoring/completion validation, and data exports pass equivalent tests. `QUESTIONNAIRES` is currently an empty reviewed-instrument registry; add a questionnaire only after exact wording, response coding, version, ethics approval, and scoring/skip logic have been reviewed.

## 4. Go-live acceptance checks

- `npm run typecheck`, `npm test`, `npm run build:pages`, server container build, and API smoke tests pass.
- No production secrets in repository or built browser assets; no participant exports in GitHub artifacts.
- CORS accepts only the Pages production origin and rejects an unrelated origin.
- Prolific preview, duplicate page refresh, browser close/reopen, partial workflow interruption, complete workflow, and exact redirect all behave as specified.
- Duplicate/replayed trial events do not duplicate decisions or completion; incomplete tasks cannot complete.
- Per-run JSON and TSV exports contain the approved analysis fields, have schema/version metadata, and match the source DB; Firebase copies are private and auditable.
- Admin requires allow-listed MFA, download actions are audited, and the public page cannot call admin routes without that identity.
- A documented pilot/stop rule exists for technical failure, duplicate Prolific sessions, missing archives, unusual completion rates, and participant support.
- Institutional approval and a data incident / withdrawal / deletion contact process are in place.
