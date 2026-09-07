# __APP_TITLE__

A React Native app on Expo with Expo Router. Previewed in the browser (aico
starts `expo start --web`), run on a phone with Expo Go or a development build,
shipped to the stores with EAS. Logic is pure TypeScript under `src/lib/`,
tested with vitest in Node; screens under `app/` only render and call.

## Layout

- `app/_layout.tsx` — the root stack. `app/index.tsx` — **the worked screen**:
  a list you can add to, tick and remove. File-based routes: `app/settings.tsx`
  is `/settings`.
- `src/lib/items.ts` — the list's logic, pure. Copy this split for every feature:
  logic in `src/lib/`, screen in `app/`.
- `test/*.test.ts` — vitest over `src/lib/`. Native rendering is checked by
  opening the app, not by a DOM that cannot host it.
- `app.json` — Expo config: name, slug, bundle ids, plugins. `deploy/` — web export and EAS notes.

## Conventions

- State changes go through pure functions that return the next state; screens
  hold `useState` and call them.
- Every pressable has `accessibilityRole` and a label; inputs have `accessibilityLabel`.
- Styles in `StyleSheet.create` at the bottom of the screen; colours in one place
  once there is more than one screen.
- No native module until a feature needs it; each one costs a rebuild.

## Checks

`npm run typecheck`, `npm test`, `npm run build` (web export). Then
`AppManage start` and `VerifyApp` the web preview: add an item, tick it, delete
it. A phone check is the person's: `npx expo start` and scan the QR code.
