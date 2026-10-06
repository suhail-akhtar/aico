# Decisions — __APP_TITLE__

One entry per decision: what, why, and what was rejected. Append; do not edit old entries.
Versions below are what `composer.lock` / `package-lock.json` resolved on 2026-10-06 and were
verified by running the whole suite on them.

## Stack and versions

- **PHP 8.5.11, Laravel 13.34.0.** Laravel 13 (released 2026-03-17) has bug fixes to Q3 2027 and
  security fixes to 2028-03; it supports PHP 8.3 to 8.5. PHP 8.5 is the newest stable line (active
  to 2027-12-31). Laravel 12 had already left bug-fix support. `composer.json` requires `^8.5`
  because that is the only version tested.
- **Blade + Livewire 4.4.7, not Inertia.** The brief is an app with interactive CRUD and auth.
  Livewire keeps validation, authorisation and rendering on the server in PHP (one language, no
  JSON endpoints for the UI to keep in sync, no client router, no Node at runtime), and its
  Alpine is bundled. Inertia would add a React/Vue/Svelte toolchain, a second set of types and a
  Node build the app does not otherwise need. Rejected: Inertia (more moving parts for the same
  screens), plain Blade with full page reloads (works, but search, tick and edit-in-place are the
  point of an app starter). Livewire runs in `csp_safe` mode so the CSP needs no `unsafe-eval`.
- **Fortify 1.40.0 for authentication, not Breeze, Jetstream or hand-written controllers.**
  Fortify is headless, maintained and receives fixes through `composer update`; Breeze copies code
  into the app, which then never gets fixes. We keep our own Blade views. Registration and password
  reset are enabled; two-factor, passkeys and email verification are one line each in
  `config/fortify.php` (see `docs/EXTENDING.md`) but off by default because they need mail and a UX
  decision. Sign-up reveals that an email is taken (the standard trade-off); the reset-link form does
  not (`GenericResetLinkResponse`).
- **Argon2id with explicit parameters (64 MiB, t=3, p=1), not the framework default and not bcrypt.**
  OWASP's minimum is m=19456 KiB, t=2, p=1; Laravel's built-in Argon2 default is 1024 KiB. bcrypt
  would also pass (cost 12) but truncates at 72 bytes. `PasswordHashingTest` pins the numbers and
  `EnvironmentGuard` refuses weaker values at startup. Passwords are 12 to 128 characters, no
  composition rules (NIST 800-63B), breached-password check in production.
- **Sanctum 4.3.3 personal access tokens for the API, not Passport or JWT.** The browser uses the
  session cookie; API clients use opaque tokens stored hashed, with an expiry (Sanctum's default is
  "never"; here 30 days). No hand-rolled JWT. Passport only if this app becomes an OAuth server.
- **dedoc/scramble 0.13.47 for OpenAPI**, generated from the code (routes, form requests, resources),
  so the document cannot be written by hand and drift. The generated file is committed and a test
  compares it with a fresh export. Only the JSON document is served: Scramble's UI loads its script
  from a public CDN, which a nonce-only CSP should not allow. Rejected: l5-swagger (annotations drift).
- **PostgreSQL 18.6 in compose and production, SQLite in memory for the default test run.** Tests
  must be fast, deterministic and offline. The verification script also runs the suite on real
  PostgreSQL (migrations, cursor pagination, LIKE escaping with `escape '!'`, which means the same in both engines). Items use ULIDs.
- **Database queue, cache and sessions.** Zero extra services at small scale. Growth path: Valkey
  (BSD-3) with Horizon, not Redis 8 (AGPL). A `queue` and a `scheduler` container run from the same image.
- **FrankenPHP 1.13.0 (Caddy + PHP 8.5.11) in classic mode, one process, non-root, port 8080.**
  Simplest robust option: no nginx plus php-fpm pair, no supervisor, HTTP/2 included, Caddy
  enforces the body-size limit before PHP and logs JSON. Octane/worker mode is an upgrade, not a
  dependency. Rejected: php-fpm + nginx (two processes, two configs), Apache.
- **Read-only root filesystem.** Framework caches (`optimize`) are built at container start into
  `/tmp` (config caching freezes `env()`, and secrets exist only at runtime); the image is
  otherwise immutable and OPcache skips file stat calls.
- **Node only in a build stage.** Vite 8.3.2 + Tailwind 4.3.3 + laravel-vite-plugin 3.2.0 compile
  `public/build`; the runtime image has no Node. `public/css/fallback.css` keeps the app usable on a
  machine with no Vite build (AICO's dev runner has no Node).
- **Pest 4.7.8 + PHPUnit 12.5.33, Larastan 3.12.3 (PHPStan 2.2.17) level 10, Pint 1.32.1 (Laravel
  preset + strict types).** These are what Laravel's own skeleton pins. Pest 5 / PHPUnit 13 exist
  (PHP >= 8.4) and are the upgrade when the skeleton moves. PHPStan analyses `app`, `bootstrap`,
  `database`, `routes`; not `tests/` (a Pest closure's `$this` is bound at run time, so level 10 reports
  noise there; `ArchitectureTest` guards structure instead). Coverage by PCOV with a gate of 85%
  (it measures 96%).
- **`composer audit` and `roave/security-advisories` dev-latest** block installing known-vulnerable
  versions; **cyclonedx/cyclonedx-php-composer 6.2.0** writes the SBOM (`make sbom`).
  `fakerphp/faker` 1.24.1 (factories), `mockery` 1.6.15 (`DB::shouldReceive` in two tests) and
  `nunomaduro/collision` 8.9.5 (readable test failures) are the only other dev packages.
- **Every command runs in Docker.** AICO must not install toolchains on a person's machine, and
  Windows bind mounts make `vendor/` slow, so `vendor/` lives in a named volume and Composer's
  cache in another. `make RUN=` runs natively for people who have PHP.

## Structure

- **`app/Features/<Name>/{Models,Actions,Policies,Http,...}` plus `app/Support`.** Fits the
  brief and is the first step to a modular monolith. `Accounts` never imports `Items`; `Support`
  never imports `Features` (enforced by `ArchitectureTest`).
- **Action classes and one DTO (`ItemInput`), no repository layer.** Eloquent is already the
  repository; a wrapper adds a class per query and no isolation. Controllers and Livewire
  components validate, authorise and call an action; both front doors share `ItemRules`.
- **Policies return 404 for foreign rows** (`denyAsNotFound`), so ids cannot be probed.
- **RFC 9457 problem details for every API error** (`urn:problem:<code>` types, `request_id`,
  `errors[]` for validation), 500s never carry the exception message.
- **Security headers middleware with a per-request CSP nonce**, JSON responses `no-store`, CORS
  allow-list that is empty by default (never `*`), API writes must be JSON (415 otherwise),
  per-token and per-email rate limits, Caddy body limit of 2 MB.
- **Fail-fast configuration** (`EnvironmentGuard`, `app:check-config`) in the entrypoint and on web
  boot: missing key, debug in production, in-memory SQLite in production, weak hashing.
- **OpenTelemetry is not installed.** `RequestContext` logs `request_id` and the W3C
  `traceparent` trace id so logs already join a trace; the SDK is a growth step (`docs/ARCHITECTURE.md`).

## Process

- **Pinned images by version and digest** (Dockerfile, compose, CI); GitHub Actions pinned by commit
  SHA (a tag compromise in March 2026 showed why). Dependabot keeps both fresh.
- **No Makefile-only entry points:** every verb exists as a plain command in `template.json` and
  `composer.json` scripts as well, for runners without `make` (Windows).
- **How AICO runs it with no PHP on the machine:** `template.json` names `composer:2.10.3` (PHP 8.5.11 +
  Composer, digest-pinned) as `docker.image`; `vendor/` and Composer's cache are named volumes mounted
  over the app directory. `php artisan app:dev` (migrate, seed, serve on SQLite) is the one-line dev command.
  It runs PHP's built-in server itself instead of `artisan serve`, because `serve` hides the process
  environment from the server it starts, so env-var configuration was silently ignored.
- **Vite `server.origin` + explicit loopback CORS** in `vite.config.js`: inside Docker the dev server
  binds 0.0.0.0 but the browser must be told `http://localhost:<port>`; the plugin then allows only that
  one origin unless `cors` is set, which broke hot reload from the app's own port.
