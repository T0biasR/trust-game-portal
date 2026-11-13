# Pavlovia release checklist

1. Create a private Pavlovia project for staging.
2. Deploy a staging Study API and whitelist the exact project origin.
3. Build `npm run build:pavlovia` and upload the resulting static project.
4. Pilot with marked staging access codes and verify completion behavior.
5. Compare the JSON/TSV export with the portal reference run.
6. Freeze protocol/client versions before production activation.
