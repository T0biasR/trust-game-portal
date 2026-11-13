# Pavlovia deployment

This directory is the Pavlovia host adapter. It intentionally uses the same
React study and Study API as the portal and JATOS builds so that schedules,
outcomes, response logging, and exports remain comparable.

Build from the repository root with `npm run build:pavlovia`. Upload the
generated `dist-pavlovia/` directory to the Pavlovia project. Configure the
Study API origin and exact allowed Pavlovia origin before piloting.

Pavlovia URL parameters may provide technical `participant` and `session`
values, but access codes remain entered on the study login screen and are never
placed in URLs.
