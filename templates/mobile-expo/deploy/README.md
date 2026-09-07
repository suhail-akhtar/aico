# Shipping __APP_TITLE__

## Web (always works)

```sh
node deploy/web.mjs             # npx expo export --platform web → dist/
```

`dist/` is a static site: Netlify, Vercel, Cloudflare Pages, S3, GitHub Pages, or any nginx.

## iOS and Android (EAS)

Done by the person with the Apple and Google accounts; aico prepares, it does not submit.

```sh
npm install -g eas-cli
eas login
eas build:configure                        # writes eas.json
eas build --platform all --profile preview # internal testing builds
eas submit --platform ios                  # App Store Connect
eas submit --platform android              # Play Console
```

Before the first build:

- `app.json`: real `name`, `slug`, `ios.bundleIdentifier` and `android.package`
  (reverse-DNS, letters and dots only — the template's placeholder contains the
  slug and must be replaced), a `version`, and icons under `assets/`.
- Any native module added since the template needs a development build
  (`eas build --profile development`) to run outside Expo Go.

## Over-the-air updates

`eas update` ships JavaScript changes to installed builds without a store release.
Configure with `eas update:configure`.
