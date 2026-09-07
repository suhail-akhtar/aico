# Decisions — __APP_TITLE__

One line per decision: what, and why. Append; do not edit old lines. Compaction
keeps this file when it drops the transcript.

- Expo with Expo Router — file-based routes, one codebase for iOS, Android and web,
  and a web preview aico can open without a simulator.
- Logic in pure modules under `src/lib/`, screens under `app/` — the logic is tested
  in Node with vitest; native rendering is checked by opening the app.
- No native modules in the template — each one costs a development build; add the
  first when a feature needs it.
- Web export as the deploy target that always works; EAS for the stores, run by the
  person with the accounts.
