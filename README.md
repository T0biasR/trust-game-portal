# Grace26 Trust Game portal — Firestore edition

This is the Firebase branch; PostgreSQL remains on `main`. GitHub Pages serves the participant interface, the browser writes only its event telemetry directly to Firestore, and a Firebase HTTPS Function runs the trusted workflow API. Its Firebase Admin identity remains server-side. The University-hosted SPP deployment can remain available separately for researcher administration behind SSO.

## Architecture

`participant browser → GitHub Pages → Firebase Anonymous Auth + Firestore (own task-event writes)`

`participant browser → Firebase HTTPS Function → Node.js/Fastify → Firestore (grants, schedules, outcomes, completion)`

The client SDK may append event records only to an active run bound to that browser's anonymous Firebase UID. The API verifies the Firebase ID token when creating or resuming a run. The browser cannot read participant records or write schedules, outcomes, workflow completion, access grants, or researcher data. Those operations continue through Fastify and the Firebase Admin SDK. Firestore client rules do not constrain Admin SDK access; protect that server identity through Google IAM and never ship its credentials to the browser.

Participant records are stored as Firestore documents, not as one JSON file per participant. The admin interface assembles a participant-scoped JSON or TSV download from those records when a researcher requests it. Cloud Storage archival files are not part of this port.

## Local development without contaminating study data

Use the Firestore Emulator for the application and end-to-end test. Do not point smoke tests at the live `trust-gamev1` project.

1. Install Node.js 22+ and a Java 21+ runtime (needed by current Firestore Emulator releases), then run `npm ci`. The emulator script fetches a pinned Firebase CLI version with `npx` on first use; it is intentionally not a production application dependency.
2. Copy `.env.example` to `.env` if you do not already have a local `.env`. Keep `FIREBASE_PROJECT_ID=demo-trust-gamev1`; set local random `CODE_PEPPER` and `DEV_ADMIN_TOKEN` values. Do not add Firebase credentials to `.env`.
3. Terminal A: `npm run emulator`. Firestore listens on `127.0.0.1:8080`, Auth on `127.0.0.1:9099`, and both use the demo project ID and the checked-in rules.
4. In `.env`, set `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` and `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099`. The example Vite emulator URLs point the browser at those local emulators.
5. Terminal B: run `npm run dev`; this starts both the API and Vite site.
6. Visit `http://localhost:5173/`. For the local admin page use `/admin` and the `DEV_ADMIN_TOKEN` from `.env`.
7. The browser writes trial events directly to the emulator; outcomes and completion still go through the local API. Emulator records stay local.

The Firebase Emulator data is in-memory unless emulator export/import is configured; restarting it provides a clean test database. No Docker or PostgreSQL is used by this variant. `npm run test:firestore-connection` is a separate read-only connectivity probe: if you configure it against the real cloud project, it only reads the `_health/connectivity` document, but it does not validate the full portal workflow.

## Checks and build

```sh
npm run typecheck
npm test
npm run build
npm run build:server
npm audit --omit=dev
```

For the SPP subpath build, use `VITE_BASE_PATH=/grace26/ VITE_API_ORIGIN=https://spp.psy.univie.ac.at/grace26 npm run build:spp`; the SPP reverse proxy must preserve the browser-visible `/grace26/` path and strip `/grace26` before forwarding to Fastify. Copy `dist/`, `server-dist/`, production `node_modules` (or run `npm ci --omit=dev` on hroot), `package.json`, and `package-lock.json`. Never copy `.env`, service-account JSON, emulator data, source maps, or test exports.

## Direct Firestore client prerequisites

In Firebase Console, add a Web App and enable **Authentication → Sign-in method → Anonymous**. Configure the public Web App values as `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, and `VITE_FIREBASE_APP_ID` at build time. Deploy `firestore.rules` to the target database. The web configuration is public; never use service-account credentials as Vite variables. Rules deny browser reads and all writes except an authenticated participant's event documents for their active run.

Deploy the rules from this directory with `npx firebase-tools@15.32.1 deploy --only firestore:rules --project trust-gamev1`. Review the project shown by the CLI before confirming. This changes Firestore security rules for that project. Enable Anonymous sign-in before testing the browser app.

The Firebase UID is pseudonymous metadata used to authorize direct event writes. Keep it out of participant analysis exports. Anonymous Auth is browser/device scoped; a participant who changes browsers may not be able to resume the same direct-write identity.

## GitHub Pages and Firebase deployment

The participant-facing app is built as static files for GitHub Pages. Firebase Anonymous Auth gives each browser session a pseudonymous identity. The browser can append task-event documents directly to Firestore only beneath a server-created, active run owned by that Firebase UID. Firestore rules deny all reads and all other browser writes. Event telemetry is still client-submitted and should be treated as untrusted; server-recorded choices, generated outcomes, and completion state are authoritative. The trusted workflow API remains server-side as a Firebase HTTPS Function: it validates Prolific entry, selects the counterbalance group, creates runs, calculates outcomes, and decides completion. This removes the University's self-managed Node process from the participant route; it does not remove Node.js backend code.

When a workflow enables task-order randomization, the API uses a cryptographic Fisher–Yates shuffle at Prolific assignment time, stores the participant's exact order and algorithm version on the access grant and run, and returns the same order on resume. Questionnaire steps keep their configured positions. Hariri Binary and Hariri Slider are registered as separate modules but remain disabled until their browser task implementations, stimuli package, and completion/data validation are accepted. The current Trust Game implementation also still needs migration to the Version 05 source before recruitment.

### Before enabling recruitment

1. In Firebase Authentication, enable **Anonymous** sign-in and add `t0biasr.github.io` under authorized domains. Register a Firebase Web App and copy its public settings into GitHub repository **Variables** (Settings → Secrets and variables → Actions → Variables): `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, and `VITE_FIREBASE_APP_ID`.
2. Register the web app with Firebase App Check using **reCAPTCHA Enterprise**. Add the actual GitHub Pages domain in the provider configuration and save its site key as `VITE_RECAPTCHA_ENTERPRISE_SITE_KEY` in repository Variables. App Check reduces abuse; it does not prove that URL parameters came from Prolific or that client event payloads are truthful. The participant API rejects requests that lack a valid App Check token. In Firebase Console, monitor App Check traffic, then enable enforcement for **Cloud Firestore** as well; that protects the direct browser event writes. Do not recruit until both the HTTPS Function and Firestore have App Check enforcement configured and verified.
3. Cloud Functions requires the Firebase project's **Blaze** billing plan. Set budget alerts before deployment. Budget alerts notify you; they do not automatically stop charges. Use the Functions maximum instance setting in `functions/index.js` as an additional capacity bound. The function is set to `europe-west10` (Berlin) to match the Firestore location you reported. Confirm the database's exact location in Firebase Console before deployment; Firebase recommends colocating the function and database to limit latency and cross-region billing.
4. Create a dedicated runtime service account named `trust-portal-runtime@trust-gamev1.iam.gserviceaccount.com` and grant only the Firestore role needed to read/write the study database (normally **Cloud Datastore User**). Set up Firebase Authentication/App Check verification permissions only if Google requires them for this project. Do not download a service-account key; Cloud Functions uses its attached identity.
5. Choose a stable random secret for `CODE_PEPPER` (at least 32 random bytes) and a separate random `OIDC_PROXY_SECRET`. Store both using `firebase functions:secrets:set CODE_PEPPER` and `firebase functions:secrets:set OIDC_PROXY_SECRET`; do not put them in GitHub or the static build. The latter is required by shared server startup validation but does not make researcher admin available through Pages. Admin remains a separate researcher-only deployment behind University SSO until a dedicated admin auth route is implemented.
6. In Firebase, create a Prolific study mapping and published workflow using the admin interface on the currently protected SPP setup. Keep `CONSENT_RELEASED=false` until the exact consent text and study protocol have ethics approval. The deployment function defaults it to false; flip it only through the private function environment config after approval.

### Deploy the API function

Create a private local file `functions/.env.trust-gamev1` (ignored by Git) with:

```dotenv
STUDY_FIREBASE_PROJECT_ID=trust-gamev1
STUDY_ALLOWED_ORIGINS=https://t0biasr.github.io
CONSENT_RELEASED=false
RESEARCHER_ACCOUNT_EMAILS=your-authorized-university-email@example.org
FUNCTION_SERVICE_ACCOUNT=trust-portal-runtime@trust-gamev1.iam.gserviceaccount.com
```

Then deploy only the function from the repository root:

```sh
firebase deploy --only functions:portalApi --project trust-gamev1
```

Use the resulting HTTPS function URL as `VITE_API_ORIGIN` in GitHub repository Variables (it ends in `/portalApi`). Confirm it returns an API response only at `/api/health`, and that calls from any other browser origin are rejected by CORS. The function's App Check verification is required in production. The Functions emulator skips App Check so it can be used for isolated local development.

### Publish GitHub Pages

The included `.github/workflows/deploy-pages.yml` builds and deploys on pushes to `firebase-direct-firestore` and manual workflow dispatch. The PostgreSQL `main` branch cannot overwrite the Firebase Pages deployment. Add all six public GitHub Variables: the four `VITE_FIREBASE_*` values above, `VITE_RECAPTCHA_ENTERPRISE_SITE_KEY`, and `VITE_API_ORIGIN`. The workflow uses the repository path `/trust-game-portal/`. In GitHub repository Settings → Pages, select **GitHub Actions** as the build and deployment source. The first successful workflow publishes `https://t0biasr.github.io/trust-game-portal/`.

Prolific appends `PROLIFIC_PID`, `STUDY_ID`, and `SESSION_ID` to the study URL. The browser forwards them to the trusted API, which checks that the study is configured and creates an idempotent assignment. These URL parameters alone are not cryptographic proof of a Prolific participant. If Prolific offers Secure External URL for this study, configure and validate that mechanism before recruitment. Set Prolific's completion URL to the exact approved code URL; the portal only redirects after server-side workflow completion.

Do not use the live Firebase project for emulator or local demonstrations. For local Functions work, use the `demo-trust-gamev1` emulator project:

```sh
cp functions/.env.example functions/.env.demo-trust-gamev1
```

Edit that copied file so `STUDY_ALLOWED_ORIGINS=http://localhost:5173` and `FUNCTION_SERVICE_ACCOUNT=local-emulator@demo.invalid`. Create the ignored `functions/.secret.local` file containing local-only values:

```dotenv
CODE_PEPPER=local-emulator-only-pepper-change-this-value
OIDC_PROXY_SECRET=local-emulator-only-proxy-secret-change-this
```

In the root `.env`, use the demo Firebase project, Auth and Firestore emulator URLs, and set `VITE_API_ORIGIN=http://127.0.0.1:5001/demo-trust-gamev1/europe-west10/portalApi`. Start `npm run emulator:functions`, then in another terminal start `npm run dev:web` and visit `http://localhost:5173/`. The Functions emulator skips App Check; it must never be pointed at the live project. The existing SPP Admin UI is not automatically exposed by GitHub Pages or the public function; do not remove its University SSO protection.

## SPP server deployment prerequisites

The user account on `hroot` can run Node.js, but the database identity and Apache integration still need to be confirmed with the administrator. Before deployment:

- Confirm which Google Cloud identity the hroot Node process can use through Application Default Credentials or Workload Identity Federation. If no federation is provided, request approval for a service-account key stored outside the web tree with restrictive file permissions. Grant only the Firestore access needed for this project/database. Never paste credential JSON into chat, source control, or the public app directory.
- Deploy `firestore.rules` to the production database. The API uses Admin SDK credentials and must be secured through IAM independently of these client rules.
- Set production `FIREBASE_PROJECT_ID=trust-gamev1`, `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=3000`, a unique `CODE_PEPPER` (32+ random characters), `OIDC_PROXY_SECRET` (32+ random characters), and `RESEARCHER_ACCOUNT_EMAILS` (comma-separated allow-list). Use secrets delivered via the approved server secret mechanism; do not reuse the example values.
- Keep `CONSENT_RELEASED=false` pending approved final consent text, privacy/retention review, Prolific linkage review, and ethics sign-off.
- Apache must proxy to loopback, preserve or consistently strip the `/grace26` prefix as tested, and enforce University SSO on `/grace26/admin` and `/grace26/api/admin/*`. It must remove any browser-provided `X-Forwarded-User` and `X-Research-Proxy-Secret` headers, then inject authenticated values itself. Confirm that the injected identity exactly matches the configured researcher email allow-list.
- Ask the administrator for an automatically restarted service, log access/retention, Firestore backup/export policy, and a staging project/database. Test public HTTPS, static assets, API, SSO, restart, and recovery before inviting participants.

Do not enable the Prolific mapping or share the URL publicly until all of these prerequisites and the research-data acceptance tests have passed. The service-account connection smoke test confirms credentials/connectivity only; it is not a deployment or study-readiness certification.
