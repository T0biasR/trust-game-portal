# Firestore backend migration design

Status: the Firestore API port and direct browser event writer are implemented
in source. They have not yet been verified together against the Auth and
Firestore Emulators; complete that local check and the hroot staging/security
review before recruitment.

## Server boundary

The browser writes append-only trial events to
`study_runs/{runId}/trial_events/{eventId}` using Firebase Anonymous Auth. The
run document is created by the API and binds the run to that anonymous UID;
rules allow that identity to create or retry unchanged event documents only
while the run is active. The browser cannot read events or write run metadata,
outcomes, workflow completion, grants, or researcher data. The Node/Fastify API
uses Firebase Admin SDK credentials for those trusted operations. Firestore
client Security Rules do not constrain Admin SDK requests.

## Proposed collections

| Collection / path | Document ID | Contents |
| --- | --- | --- |
| `access_grants/{grantId}` | random UUID | Assignment, status, expiry, recruitment metadata, current run pointer |
| `access_code_index/{codeHash}` | HMAC digest | Maps a submitted code digest to one grant ID; contains no plaintext code |
| `participant_sessions/{tokenHash}` | HMAC digest | Grant ID, expiry, last-seen time |
| `access_grants/{grantId}/consents/{consentId}` | random UUID | Consent document version, decision, server timestamp |
| `access_grants/{grantId}/participant_events/{eventId}` | random UUID | Append-only participant lifecycle events |
| `study_runs/{runId}` | random UUID | Protocol, schedule, seed, host metadata, immutable workflow step order and randomization method, status and completion summary |
| `study_runs/{runId}/trial_events/{eventId}` | client event UUID | Append-only trial event with sequence and server timestamp |
| `study_runs/{runId}/outcomes/{trialId}` | stable trial ID | Server-resolved outcome; immutable/idempotent after first resolution |
| `study_runs/{runId}/risk_resolutions/{trialId}` | stable trial ID | Server-resolved risk result |
| `study_runs/{runId}/workflow_steps/{stepId}` | stable step ID | Workflow progress and validated questionnaire response |
| `study_runs/{runId}/trustee_policy/current` | fixed | Trustee decisions and quality status |
| `workflow_definitions/{workflowId}` | random UUID | Immutable versioned workflow definition |
| `prolific_studies/{studyId}` | Prolific study ID | Active workflow mapping and validated completion URL |
| `counterbalance_allocators/{stratum}` | stable stratum ID | Transactional assignment counts / next assignment state |
| `admin_audit/{auditId}` | random UUID | Researcher action, actor, detail and server timestamp |

Participant event histories and trial events are separate documents, never an
ever-growing array in the run document. This keeps each write bounded, makes
exports paginatable, and avoids the Firestore document-size ceiling.

## Required invariants in the port

1. Access-code authentication looks up only an HMAC digest; plaintext codes are
   returned once at generation and never persisted.
2. Session creation, grant activation, Prolific session creation, and
   counterbalance allocation use Firestore transactions where atomicity is
   required. Counterbalance allocation must remain deterministic and
   concurrency-safe.
3. Trial-event ingestion is idempotent by event UUID. Direct browser rules
   prevent edits to event content on retry; server completion checks count
   distinct completed trial IDs. Sequence values are participant-generated
   ordering metadata, not a trusted anti-tampering mechanism.
4. Outcome requests validate against the server-owned schedule. Repeated
   identical requests return the stored result; a conflicting second choice is
   rejected. Server-generated outcomes and completion records are immutable.
5. A grant points to at most one immutable run. Creation uses a transaction so
   concurrent start requests cannot create duplicate runs; prior run records
   are never removed by a development-only protocol rollover.
6. Completion checks use server-side event/outcome documents and required
   workflow-step states. Client-supplied summaries are supplementary, never
   proof of completion.
7. Export queries are bounded, preserve sequence order, retain the
   existing JSON and trial-level TSV schemas, and record an audit event.
8. Firestore rules deny browser reads and all writes except event creation or
   unchanged retries for the authenticated owner of an active run. The Node
   server's IAM principal receives only the permissions it needs; no key is
   stored in source control or the app directory.

## Migration sequence

1. Read-only cloud connectivity smoke test (implemented).
2. Firestore Emulator setup and an API smoke test (implemented; not yet run in
   this environment because Java is unavailable).
3. Review endpoint parity, transaction invariants, and export schemas with
   synthetic emulator data.
4. Deploy this Firestore-only copy to an isolated hroot staging directory and
   verify server credentials/IAM and the reverse proxy.
5. Obtain ethics/privacy sign-off and test participant/admin workflows before
   considering real recruitment. The separate PostgreSQL deployment remains
   unchanged.
