# Online Trust-Game Research Platform

Production-oriented platform for a German-language online behavioral study. It supports local/manual invitation-code testing and adds a Prolific participant workflow. The Trust Game is the only active experimental module; Hariri/Mausland and questionnaire instruments stay disabled until independently reviewed and implemented. The repository also contains the PsychoPy MRI sources used as historical references, including the current block-design reference in `2026-09-16_Trust_Game/`.

The frozen task rationale, schedule, event dictionary, quality policy, and online-to-fMRI modeling contract are documented in [`docs/TRUST_PROTOCOL.md`](docs/TRUST_PROTOCOL.md).

## Local setup

Requirements: Node 22+, Docker, and Docker Compose.

1. Copy `.env.example` to `.env` and replace all secrets.
2. Start PostgreSQL with `docker compose up -d postgres`.
3. Run `npm install`, then `npm run dev`.
4. Open `http://localhost:5173` and use the configured `DEV_ACCESS_CODE`.
5. Open `http://localhost:5173/admin` and use `DEV_ADMIN_TOKEN` during local development.

The API automatically applies the idempotent schema in `server/schema.sql`. Local admin uses `DEV_ADMIN_TOKEN`; production admin can use the configured Firebase email/password + TOTP MFA flow and server-side allow-list. The legacy institutional OIDC proxy path remains available. Do not expose the admin API without one of these authenticated paths.

## Study release order

1. Obtain institutional approval for the exact consent and data flow, including Prolific PID/Study/Session linkage, GitHub Pages hosting logs, Cloud Run/Cloud SQL, Firebase Storage, retention and withdrawal handling. Set `CONSENT_RELEASED=true` only after approval; production otherwise refuses to create any run.
2. Run usability, browser, timing, security, Prolific Preview, interruption/resume, redirect, and computational-recovery pilots on a separate staging database.
3. Create and publish a reviewed workflow in Study Administration, map the Prolific Study ID and completion URL, and keep it inactive until pilot sign-off.
4. Freeze and preregister the protocol before activating production recruitment.

The current MRI-matched investor task uses the fixed probability schedules from
`2026-09-16_Trust_Game/paradigm_outcomes.json`. Trustee norming and recorded-human
outcome banks remain supported as a future extension, but are not required for
the current investor task.

## Commands

- `npm run dev` — frontend and API development servers
- `npm run typecheck` — browser and server TypeScript checks
- `npm test` — protocol property and payoff tests
- `npm run build` — production frontend build
- `npm run build:pages` — static GitHub Pages participant bundle in `dist-pages/`
- `npm run build:jatos` — build a self-contained JATOS study package in `dist-jatos/`
- `npm run build:pavlovia` — build a self-contained Pavlovia study package in `dist-pavlovia/`
- `npm run start` — API and production static server

GitHub Pages serves only the static client. It requires `VITE_API_ORIGIN` to
point at the HTTPS Fastify API; GitHub Actions is configured in
`.github/workflows/deploy-pages.yml`. JATOS and Pavlovia remain separate
hosted builds using their respective adapters. Whitelist only exact production
origins with `STUDY_ALLOWED_ORIGINS`. Never place database credentials,
peppers, Firebase service credentials, or access-code material in a hosted
bundle.

## Data design

The server owns schedules and resolves every outcome. Trial and quality records are append-only and idempotent. Manual invitation-code records do not contain names or email addresses. For Prolific, the PID, Study ID, and Session ID are intentionally retained with the internal grant so recruitment and completion can be reconciled. Therefore Prolific records and exports are pseudonymous, not anonymous. The JSON/TSV archives go to private Firebase Storage through the API service identity; PostgreSQL remains authoritative.

The browser queues unconfirmed event batches locally and reconciles them with server sequence numbers after reconnecting. A block-design run completes only after all 72 active Trust Game outcomes are present and all pending events have reached the server.

The modeling package under `modeling/` consumes the research JSON export and produces versioned hierarchical posterior artifacts for later use as group-level fMRI priors. The export excludes invitation-code hashes but Prolific exports retain direct platform identifiers. The project-end SQL script only de-links PostgreSQL; it does not delete or rewrite Firebase Storage copies. A reviewed retention/deletion procedure for those cloud objects is still required before production collection.

## Project-end retention

The project-end SQL operation is irreversible. Do not run it until an approved retention date, encrypted backup, checksummed final archive, target confirmation, and dual-review procedure are in place. The SQL de-links PostgreSQL records, but does not touch Firebase Storage, GitHub Pages logs, Cloud Run logs, or external Prolific records. Add and test an approved deletion/redaction procedure for each such copy before collecting live participants.
