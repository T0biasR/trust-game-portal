# JATOS deployment

This directory is the JATOS host adapter. The Trust Game remains the shared
React study and uses the common Study API for authentication, scheduling,
outcomes, event persistence, and exports.

Build from the repository root with `npm run build:jatos`. Upload the generated
`dist-jatos/` directory as a JATOS study component after replacing the
non-secret values in the generated host configuration.

JATOS result data is a technical fallback only. The PostgreSQL-backed Study API
is the authoritative research record.
