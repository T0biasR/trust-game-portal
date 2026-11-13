# JATOS release checklist

1. Deploy a staging Study API and whitelist the exact JATOS origin.
2. Build `npm run build:jatos` and upload `dist-jatos/` as a component.
3. Pilot with marked staging access codes.
4. Compare the JSON/TSV export with the portal reference run.
5. Freeze protocol/client versions before production activation.
