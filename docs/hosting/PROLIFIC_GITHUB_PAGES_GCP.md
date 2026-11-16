# Prolific + GitHub Pages + Cloud Run deployment

This is an implementation/operations checklist, not authorization to collect data. Keep the Prolific mapping inactive until the local and staging acceptance checklist is signed off and the University data-protection / ethics reviewers approve the exact deployment, consent text, and Prolific-ID handling.

The current `main` code uses PostgreSQL as its authoritative database. Firebase
is used for private JSON/TSV archive copies and researcher Authentication; it is
not the participant database in this branch. Do not mix the separate Firestore
prototype into this deployment.

## Current division of responsibilities

- GitHub Pages serves the static React/Vite participant interface. It has no database credentials and cannot write research data directly.
- The Cloud Run API (Fastify) validates the Prolific study/session, creates the pseudonymous internal run, enforces the workflow and completion criteria, and is the only application component allowed to write research data.
- Cloud SQL for PostgreSQL is the authoritative transactional store and retry queue.
- A Cloud Run service account uses Application Default Credentials to copy completed per-participant JSON and TSV exports into a private Firebase Storage bucket. Browser users and anonymous Firebase clients receive no Storage access.
- The researcher interface uses Firebase Authentication accounts and requires email verification, allow-listed accounts, and TOTP MFA. Keep researcher account creation restricted to administrators.

## 1. GitHub Pages

The current deployment workflow publishes a **static hosting preview only**.
It deliberately has no API origin and renders a notice that data is not saved.
Do not recruit participants or treat this deployment as a functional study.
Once the PostgreSQL staging API is deployed and verified, change the workflow
to the connected build mode and add only the public client configuration it
requires.

1. This repository is currently public, so all tracked source, study materials,
   and Git history are publicly readable. Confirm this is approved by the
   University before using the URL with participants. Never commit `.env`,
   service-account credentials, participant exports, Firebase rules that grant
   public access, or production database snapshots.
2. In repository Settings → Pages, select GitHub Actions as the deployment source.
3. The static preview needs no GitHub variables. For the later connected
   deployment, in Settings → Environments open or create the `github-pages`
   environment and set these public build-time variables (not credentials):
   - `STUDY_API_ORIGIN`: the HTTPS Cloud Run API origin, without a trailing slash.
   - `PAGES_BASE_PATH`: defaults to `/trust-game-portal/` for this repository.
     Set it to `/` only for a user site or custom domain.
   - `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_APP_ID`, `FIREBASE_PROJECT_ID`: Firebase Web App public configuration used only for named researcher login.
4. Push the reviewed preview changes to `main`, or run “Deploy participant portal” from Actions. After a successful deployment, visit `https://t0biasr.github.io/trust-game-portal/` and confirm the preview notice and status list appear. This validates static hosting only.
5. After the PostgreSQL API is deployed, switch to connected build mode, configure its HTTPS origin and Firebase Web App settings, and add the Pages hostname to Firebase Authentication's authorized domains. Use a University-owned custom domain if policy permits; otherwise the GitHub-hosted URL remains visible to participants and GitHub's hosting infrastructure.
6. Only after the connected build and staging API are verified, test direct Prolific entry with a Prolific preview URL. Confirm the three parameters arrive, the browser URL is cleaned after entry, refresh resumes the same session, and no access code is shown.

The generated public client config is not a secret. Firebase Storage bucket credentials, service-account keys, database passwords, and API signing/pepper values are secrets and must never be Vite variables or GitHub build variables.

## 2. Google Cloud backend

Use a University-approved Google Cloud project and region. If policy permits,
keep staging isolated in its own project; at minimum use separate staging
Cloud Run service, Cloud SQL instance, archive bucket, and researcher auth
configuration. Berlin (`europe-west10`) is a candidate because Cloud Run,
Cloud SQL for PostgreSQL, and Cloud Storage list it as available. Confirm that
location meets the institution's data-residency policy before creating
resources; region choice is not itself institutional or legal approval.

Before provisioning, confirm the project is linked to the approved billing
account, estimate Cloud SQL and Cloud Storage costs, and create a project
budget with alerts. Budget alerts alone do not stop charges; Cloud SQL can
continue accruing its instance cost even when Cloud Run is scaled to zero.

1. Create a Cloud Run service account with least-privilege access to Cloud SQL, Secret Manager, and the private archive bucket. Do not download a JSON key; Cloud Run uses its attached identity.
2. Create a private Cloud SQL for PostgreSQL instance, database, and restricted application user. Keep the database off the public internet. Connect Cloud Run through the Cloud SQL integration/socket. Set a Cloud Run maximum instance count and `DB_POOL_SIZE` together so autoscaling cannot exhaust the database connection budget. Enable automated backups and PITR after reviewing storage cost; document retention and test restoring a backup.
3. Create a private Firebase Storage bucket in the approved region. Enforce uniform bucket-level access, public access prevention, restrictive IAM, lifecycle/retention policy, and audit logging. Firebase Storage requires a billable project configuration; estimate and monitor costs before enabling participant collection.
4. Deploy the API container from the repository's `Dockerfile`. The checked-in
   `.gcloudignore` excludes local `.env*` files, exports, and build outputs from
   source uploads; inspect the upload file list before the first build. Attach
   the service account and Cloud SQL instance. Store `DATABASE_URL` in Secret
   Manager using the Cloud SQL socket/connector connection string; the current
   local Compose URL is not a production connection string. Cloud Run must
   allow public invocation for unauthenticated participant browsers; participant
   sessions are authenticated by the application, while the database remains
   reachable only through Cloud Run's Cloud SQL connector.
5. Set required runtime environment/secrets: `NODE_ENV=production`, `CODE_PEPPER`, `OIDC_PROXY_SECRET` (random, at least 32 characters; retain even when Firebase MFA is used), `DATABASE_URL`, `CONSENT_RELEASED=false` until authorized, `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET`, `RESEARCHER_ACCOUNT_EMAILS`, and `STUDY_ALLOWED_ORIGINS` containing only the exact GitHub Pages origin (scheme + hostname, no path). Configure Cloud Run ingress, concurrency, max instances, health check, request logging policy, and scaling intentionally.
6. Configure HTTPS custom domain if available. Test `/api/health`; then run smoke tests with synthetic records only. Verify DB migration, CORS/preflight from Pages, participant session resume, server-side completion checks, archive retry, private bucket object access, and admin download audit logs.
7. Enable email/password sign-in and TOTP MFA in Firebase Authentication. Firebase's TOTP MFA requires upgrading Authentication to Identity Platform; check its pricing and billing impact before enabling. Create named researcher identities, require verified email and MFA enrollment, set the server allow-list, and test successful MFA plus rejection of non-allow-listed/no-MFA accounts. Enable account recovery and an offboarding procedure.
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
