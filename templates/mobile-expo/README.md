# __APP_TITLE__

__APP_DESCRIPTION__

A React Native app on [Expo](https://expo.dev) with Expo Router. One codebase
for iOS, Android and the web.

## Run

```sh
npm install
npm run dev                 # web preview at http://localhost:8081
npx expo start              # QR code for Expo Go on a phone; a/i for emulators
```

## Check

```sh
npm run typecheck
npm test                    # the pure logic under src/lib
npm run build               # web export to dist/
```

## Ship

- **Web**: `node deploy/web.mjs` exports a static site to `dist/`; any static host.
- **iOS / Android**: EAS Build — see `deploy/README.md`. Set the bundle ids in
  `app.json` first.

## Structure

```
app/_layout.tsx      root stack
app/index.tsx        the worked screen
src/lib/items.ts     its logic, pure and tested
test/                vitest
app.json             Expo config
deploy/              web export, EAS notes
```
