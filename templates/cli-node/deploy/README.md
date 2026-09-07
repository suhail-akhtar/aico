# Shipping __APP_TITLE__

A CLI ships as a package, not a server.

| Way | Command |
|---|---|
| Tarball to hand around | `node deploy/pack.mjs` → `__APP_SLUG__-<version>.tgz`; install with `npm install -g ./__APP_SLUG__-<version>.tgz` |
| npm registry | `npm publish` (after `npm login`; set `"private": false` and a scoped name if needed) |
| Straight from Git | `npm install -g github:<owner>/<repo>` — the `prepare` hook is not defined here, so add `"prepare": "npm run build"` first |
| Single executable | `node --experimental-sea-config sea-config.json` on Node 22, if a no-Node install is required |

## Before publishing

- `npm run typecheck && npm test && npm run build` pass from a clean clone.
- `package.json` `name`, `bin`, `version` and `files` are right; `files` keeps the tarball to `dist/` and the README.
- `node dist/index.js --help` prints the contract you mean to keep.
