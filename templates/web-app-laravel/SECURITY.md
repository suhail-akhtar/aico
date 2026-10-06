# Security policy

## Reporting a vulnerability

Do not open a public issue. Email the address in `CODEOWNERS`' security contact, or use your host's
private vulnerability reporting (for example GitHub "Report a vulnerability"). Include steps to
reproduce and the version (`CHANGELOG.md`). Expect an acknowledgement within three working days.
(Placeholder: replace this paragraph with your real contact before you publish the project.)

## What this application does for you

- Passwords: Argon2id (64 MiB, t=3, p=1), 12 to 128 characters, breached-password check in
  production, rehash on login, sign-in and token endpoints throttled per email and IP.
- Sessions: database-backed, HTTP-only, `SameSite=Lax`, `Secure` in production, regenerated on sign-in;
  CSRF protection on every web form.
- API: bearer tokens stored hashed with an expiry; JSON only on writes; per-token rate limit; no cookies,
  so no CSRF surface; CORS allow-list empty by default.
- Authorisation: policies on every model; another user's record is a 404.
- Output: Blade escapes by default (`{!! !!}` is banned in review); CSP with a per-request nonce, no
  `unsafe-inline`, no `unsafe-eval`; `nosniff`, frame denial, referrer and permissions policies; HSTS over HTTPS.
- Errors: RFC 9457 problem details; a 500 never carries the exception message.
- Configuration: environment only; the app refuses to start without `APP_KEY`, with debug on in
  production, or with weak hashing.
- Container: non-root, read-only root filesystem, all capabilities dropped, no-new-privileges, no dev
  packages, no `.env`, no tests.
- Supply chain: `composer.lock` and `package-lock.json` committed; `composer audit` and
  `roave/security-advisories` in CI; SBOM (`make sbom`); pinned images (version and digest) and
  GitHub Actions pinned by commit SHA; Dependabot.

## What you must still do

Terminate TLS in front of the container; keep `APP_KEY` and database credentials in a secret store;
decide the sign-up policy; take and test database backups; review dependency updates; enable email
verification and two-factor authentication if your users need them (`docs/EXTENDING.md`).
