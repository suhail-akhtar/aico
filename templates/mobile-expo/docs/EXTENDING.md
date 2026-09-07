# Extending this app

## Add a screen (the main move)

1. Logic first: `src/lib/<feature>.ts` with pure functions that take state and
   return the next state (copy `items.ts`). Test it in `test/`.
2. Screen: `app/<feature>.tsx` — `useState` for the state, the lib for changes,
   `StyleSheet.create` at the bottom. Copy `app/index.tsx`.
3. Navigate: `<Link href="/<feature>">` from another screen, or a tab layout
   (`app/(tabs)/_layout.tsx` with `Tabs` from expo-router) once there are three.
4. `RunChecks`, then `AppManage start` and `VerifyApp` the web preview.

## Persist state

`expo-sqlite` for records, `@react-native-async-storage/async-storage` for a few
keys. Wrap either in a `src/lib/storage.ts` with load/save functions so the
pure logic stays pure and the tests stay in Node.

## Call an API

`fetch` works on all three platforms. Put calls in `src/lib/api.ts`, inject
`fetch` for tests, and keep tokens in `expo-secure-store`, never in the bundle.

## Add a native module

`npx expo install <module>`, then a development build (`eas build --profile
development`) — Expo Go cannot load custom native code. Do this once, for the
first module; later ones ride the same build.

## Ship

- Web: `node deploy/web.mjs` → `dist/`.
- Stores: set `ios.bundleIdentifier` and `android.package` in `app.json`
  (reverse-DNS, no hyphens), then `eas build` and `eas submit` (see `deploy/README.md`).

## What not to do

- No logic in screens; no `useState` mutation of arrays in place.
- No secrets in `app.json` or the bundle.
- No jsdom tests of native components; test logic in Node, screens in the preview.
