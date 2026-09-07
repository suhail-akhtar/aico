# Backlog — __APP_TITLE__

Stories are vertical slices: logic (pure, tested) → screen → checked in the web
preview. Tick a box only when its "Done when" was observed.

## Iteration 0 — from the template

- [x] A list screen: add, tick, delete, open before done, newest first.
      Done when: the items tests pass and VerifyApp on the web preview adds and ticks an item.
- [x] Root stack with a titled screen; status bar follows the system theme.
      Done when: the title shows in the web preview header.
- [x] Web export works.
      Done when: `npm run build` writes `dist/index.html`.

## Iteration 1 — make it this app

- [ ] Replace the list with the app's first real screen, keeping the logic/screen split.
      Done when: its logic has tests and the screen renders in the web preview.
- [ ] Persist state (AsyncStorage or SQLite via expo-sqlite) — decide with the user.
      Done when: an item survives a reload of the web preview.
- [ ] Set the real name, slug and bundle identifiers in `app.json`.
      Done when: `npx expo config` shows them and `eas build --profile preview` is possible.
