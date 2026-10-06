# Decisions — __APP_TITLE__

One line per decision: what, and why. Append; do not edit old lines. Compaction keeps this
file when it drops the transcript. Versions are the ones resolved in `uv.lock` on 2026-10-06
(checked against PyPI and the projects' release pages that day); every dependency in
`pyproject.toml` is pinned exactly and used.

## Platform

- Python 3.14 (resolved CPython 3.14.8 in the image; `>=3.14` required) — supported to 2030,
  `uuid.uuid7()` is in the standard library, and the official FastAPI template targets it.
  3.15 is due 2026-10-09; move after 3.15.1 and wheel availability, by changing `.python-version`,
  `requires-python` and the Dockerfile digests together.
- uv 0.12.23 with a committed `uv.lock` — one tool for the interpreter, the lock and the venv;
  `uv sync --locked` fails if the lock is stale, and `uv export` feeds the audit and the SBOM.
- The runtime stage runs `apt-get upgrade` (a pinned digest lags Debian security fixes; Trivy found a
  fixable HIGH on the day this was built) and deletes pip (its vendored urllib3 and msgpack are what
  scanners flag and the service never runs pip). CI fails the image job on any fixable HIGH or CRITICAL.
- Image `python:3.14-slim` pinned by digest, three stages (build, tools, runtime) — the runtime
  has the venv and nothing else; not Alpine because musl lacks wheels for several dependencies.
  Docker Hardened Images are the upgrade path once a registry login policy is decided.
- uvicorn directly, not gunicorn — one process per container is the Kubernetes model and
  uvicorn's own `--workers` (`WEB_CONCURRENCY`) covers the single-container case, so gunicorn
  and a worker package would be two more dependencies for no gain. uvloop and httptools are
  installed because uvicorn uses them automatically and they are the fast path.

## Libraries

- FastAPI 0.142.2 (Starlette 1.7.0), Pydantic 2.13.5, pydantic-settings 2.15.0 — pinned to the
  exact version because FastAPI is still 0.x; bump deliberately.
- SQLAlchemy 2.1.3 async + Alembic 1.20.0 — the standard, with the 2.0 typed `Mapped[]` API so
  mypy checks queries. No SQLModel (pre-1.0, couples table and API models).
- psycopg 3.3.6 (binary) — one driver, async and sync; asyncpg rejected as a second driver
  with no need. Note: psycopg's async mode needs the selector event loop, which Windows does not
  use by default: run PostgreSQL-backed tests in Docker (`make test-pg`), where they are
  verified. Development on Windows uses SQLite.
- pwdlib 0.3.1 (Argon2id) with explicit parameters m=64 MiB, t=3, p=2 — above the OWASP
  minimum (m=19 MiB, t=2, p=1); a test pins them and the config refuses to go below the minimum
  outside `APP_ENV=test`. passlib (unmaintained) and bcrypt (72-byte limit) rejected.
- PyJWT 2.15.1, HS256, without the `crypto` extra — a single service signing and verifying its own
  tokens needs a shared secret, not asymmetric keys; `cryptography` would be a large dependency
  for nothing. When another service must verify tokens, switch to RS256/ES256 or an OIDC
  provider and add `pyjwt[crypto]`. python-jose rejected (unmaintained).
- structlog 26.1.0 — JSON on stdout, context variables carry the request id, key-based
  redaction, and `show_locals=False` on tracebacks (locals would print passwords).
- limits 5.8.0 — the maintained, typed rate-limit core behind slowapi; used directly because
  slowapi's decorator model needs a `request` argument in every handler and is poorly typed.
  Behind a `RateLimiter` port so Redis is a new class, not a rewrite.
- OpenTelemetry through FastAPI's native support (0.142+) with `opentelemetry-sdk` and the OTLP/HTTP
  exporter, all 1.45.0 stable — off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. The
  `opentelemetry-instrumentation-*` contrib packages (0.66b0) are beta-labelled and not needed.
- email-validator 2.3.0 (via `pydantic[email]`) — real address validation; rejects reserved names.

## Dev and test tooling

- pytest 9.1.1, pytest-asyncio 1.4.0, pytest-cov 7.1.0 (coverage 7.16.2), httpx 0.28.1,
  hypothesis 6.168.5, schemathesis 4.29.3, aiosqlite 0.22.1 (SQLite for the default run),
  watchfiles 1.3.0 (reload), ruff 0.16.10, mypy 2.4.0, bandit 1.9.4, pip-audit 2.10.1.
- Tests run on in-memory SQLite by default (fast, no Docker, agents can run them anywhere) and
  on real PostgreSQL via `TEST_DATABASE_URL` (`make test-pg`, and the CI matrix runs both). SQLite
  is not trusted alone: the property tests found a PostgreSQL-only 500 (a NUL byte in a search
  string) that SQLite accepted. Testcontainers rejected: a compose service and a CI service
  container give the same real database without Docker-in-Docker.
- Schemathesis against a real loopback server, with `positive_data_acceptance` excluded (OpenAPI's
  `format: email` is looser than email-validator); it found strict-typing, `Allow`-header and
  unknown-query-parameter gaps that example tests missed, all fixed.
- ruff replaces black, isort, flake8 and pylint; its `S` rules duplicate bandit on purpose
  (editor feedback, then CI). mypy `--strict` over `src`; pyright was not adopted (one checker is
  enough, and the pydantic plugin is mypy's).
- Dependency audit: `pip-audit` over `uv export`, any finding fails (pip-audit has no severity),
  accepted exceptions live in `.pip-audit-ignore` with an expiry date. `osv-scanner` runs in CI.
- Makefile with the AICO verbs, plus the plain `uv run` line for each (no `make` on Windows).

## Design

- Layered with feature folders (`features/<name>/{models,schemas,repository,service,deps,router}`),
  one composition root (`main.create_app`), DI through `Depends`. No DI framework, no generic
  repository base class, no hexagonal ports for CRUD; the one port is `RateLimiter` because Redis
  is a real, near-term swap. Layering rules are tests, not prose.
- Service owns the transaction (`commit()`), the session never auto-commits — the boundary is
  visible in the code. Repositories take `owner_id` in every query: another user's row is a 404,
  never a 403.
- UUIDv7 primary keys generated in the app — non-enumerable, time-ordered (index-friendly), and
  the id alone gives a correct keyset cursor. Keyset pagination (`limit`, opaque `cursor`),
  capped at 100.
- Bearer tokens, not cookie sessions — the API serves mobile apps and third-party clients, and
  an `Authorization` header is not sent by the browser on its own, so there is no CSRF surface.
  Access token 15 minutes (HS256); refresh token 14 days, opaque, stored as SHA-256, rotated on
  every use, one family per login; presenting a retired token revokes the family. For a
  browser-only front end, a BFF with an `HttpOnly` cookie is the alternative (`docs/EXTENDING.md`).
- Errors are RFC 9457 problem+json with a stable `code`, `urn:problem:<code>` as `type`, the
  request id, and no echoed input. Validation is strict and `extra="forbid"` on request bodies
  and query strings.
- `/v1` prefix for the API, probes at the root. `openapi.json` is committed and tested for
  freshness, so contract changes are visible in review.
- Security headers on every response including errors; CSP `default-src 'none'` except on the
  docs page; `Cache-Control: no-store`; HSTS only over HTTPS; CORS by allow-list, no credentials.
- Config only from the environment, validated at startup, production refuses SQLite and
  placeholder secrets. `.env.example` is tested to document every setting.
- Migrations run from code (`python -m app.cli migrate`, compose `migrate` service), never from
  every replica at boot; `AUTO_MIGRATE` exists for development only.

## Rejected for the base starter (documented growth steps in `docs/ARCHITECTURE.md`)

CQRS and event sourcing, a message bus, Redis, background-job framework, outbox and
idempotency keys (medium and up), GraphQL, multi-tenancy, email verification and MFA,
Kubernetes manifests, a service mesh.

## OIDC resource-server mode (template 1.1.0, 2026-10-06)

Why: the starter is also the API half of a full-stack bundle in which one single-page app sits
behind a gateway (Traefik, oauth2-proxy as the backend-for-frontend) and Keycloak is the identity
provider. The browser never holds a token; the gateway forwards `Authorization: Bearer <access
token>` and the API must verify it. Standalone use is unchanged: `AUTH_MODE` defaults to `local`.

- `AUTH_MODE=local|oidc`, one process, two verifiers behind the one `CurrentUser` seam — not a
  second service or a second code path in the routes. The ordinary item routes, ownership checks
  and their tests do not know which mode runs; `tests/contract/test_wire_contract.py` runs the
  same assertions in both. Rejected: a separate "oidc" branch of the template (two things to
  maintain), and trusting the gateway's say-so (an `X-User` header): the API is then only as safe
  as every network path to it, so the token is verified here too (defence in depth).
- Required in `oidc` mode and failing startup by name: `OIDC_ISSUER` (exact `iss`),
  `OIDC_JWKS_URI`, `OIDC_AUDIENCE` (`aud`; the bundle adds a Keycloak audience mapper for
  `app-api`). The key URL is configured, not derived from the issuer, because it is normally an
  internal address (`http://keycloak:8080/...`) while the issuer is the public URL. No OIDC
  discovery for the same reason, and one fewer outbound call at startup.
- RS256 pinned in two places: the unverified header must say RS256 before any key is looked up
  (so `none`, HS256-with-the-public-key-as-secret and a missing `kid` never reach a key, never cause
  a fetch), and `algorithms=["RS256"]` again inside PyJWT. ES256/EdDSA are not accepted until a
  provider needs them (widen `ALGORITHM` and `_parse_keys` together, add a test).
- Time is checked against the injected `Clock`, not PyJWT's wall clock, so tests move time; `exp`
  and `nbf` leeway is configurable but capped at 60 s; a NaN or non-numeric `exp` is rejected
  explicitly (`nan <= now` is false, which would read as "not expired"). `sub` must be a canonical
  UUID because it becomes the primary key.
- `pyjwt[crypto]==2.15.1` (resolves `cryptography` 50.0.2, licence Apache-2.0 OR BSD-3-Clause;
  its only other requirement, `cffi` 2.x, was already in the lock through Argon2). Supersedes the
  "without the crypto extra" line above: that was right while this service signed its own tokens
  with a shared secret; verifying a provider's RS256 signature needs an RSA implementation and
  PyJWT has none of its own. Lock regenerated with uv 0.12.23 inside Docker; `uv sync --locked`
  and the audit pass. The extra is the one PyJWT documents, so no direct `cryptography` pin to
  keep in step.
- JWKS fetch with the standard library (`urllib`, in a worker thread, with a deadline, a 256 KiB
  cap and redirects refused), not `PyJWKClient`, not `httpx` at runtime. `PyJWKClient` refetches on
  every unknown `kid`, so one client sending random `kid`s turns the API into a load generator
  against the provider, and it blocks the event loop. `httpx` is a dev dependency only; promoting it
  would add httpx, httpcore, h11, certifi and idna to the runtime and the audit surface for one GET
  every few minutes. Rejected too: Authlib and python-jose (a framework, and an unmaintained
  library, for what is about 200 lines).
- Key cache policy: refetch on an unknown `kid` or when older than `OIDC_JWKS_CACHE_SECONDS`
  (600), never more often than `OIDC_JWKS_MIN_REFETCH_SECONDS` (30), one fetch shared by concurrent
  requests (an `asyncio.Lock`, with the hot path lock-free). While the provider is down the last
  good keys keep working (a short outage must not log everyone out); with no keys at all the answer
  is 503, not 401. A revoked key therefore stays valid here for up to ten minutes: a documented
  trade-off, tunable. An empty or malformed key set never replaces a working cache.
- Bad tokens are one generic 401 problem+json (`WWW-Authenticate: Bearer`); the reason (an
  exception class name, never the token) is logged at info so a wrong issuer is found in minutes.
  Token size cap 8 KiB (the local token cap is 4 KiB): a provider puts roles and profile claims in.
- Identity mapping: user id = `sub`; email = the `email` claim lower-cased, or
  `<sub>@oidc.invalid` (reserved TLD, unique per subject, so address-less accounts never collide
  on the unique email column). No schema change and no migration.
- Just-in-time provisioning, not a pre-provisioning step or a sync job: items refer to
  `users.id`, so the row must exist; creating it on the first verified token needs no operator
  action and no second source of truth. Race-safe without a lock: concurrent first requests
  insert the same primary key, the database picks one, the loser re-reads the winner's row.
- Email collisions: another row with the same email and a different id is a 409
  (`urn:problem:identity-conflict`), never a merge, and never decided by `email_verified`. An
  email string is not proof of identity: two people can share one, and an attacker can register
  someone else's address at a provider that does not verify it. Merging would hand the attacker
  the victim's items; refusing costs a person a support request. The email is captured at first
  sight and not re-synced on later requests (a change needs the same collision rule: documented
  growth step in `docs/EXTENDING.md`). A disabled account (`is_active` false) is a 401, as before.
- The provisioned row stores `UNUSABLE_PASSWORD_HASH`, a string no hasher recognises. A local
  login against it must be the ordinary 401: `PasswordService.verify` catches pwdlib's
  `UnknownHashError`, spends the time of a real verification and answers "not valid", so the
  reply is neither a 500 nor an oracle that tells provider accounts from password accounts.
- `register`, `login`, `refresh` and `logout` answer 404 (`Local authentication is disabled:
  AUTH_MODE=oidc`) through the same dependency that builds `AuthService`, so the check cannot be
  forgotten on a new endpoint; the dev seed and `purge-tokens` become no-ops. `JWT_SECRET` is not
  required in `oidc` mode: nothing is signed, and a required secret that does nothing is a secret
  to leak. `openapi.json` is unchanged.
- Wire contract with the bundle's generated client: this starter already matched (snake_case,
  `limit`/`cursor`/`next_cursor`, optional `quantity`, problem+json). Kept as it is: the default
  page size stays 20 (the contract text says 50; the client sends `limit`), and the description cap
  stays 2000 (a superset of 1000). Tests now pin the contract in both modes.
- Tests use a generated RSA key pair and an injected fetcher (no Keycloak, no network); the real
  `urllib` fetcher is tested once against a loopback server (status, size, JSON, redirect,
  deadline). The concurrency test uses a file-backed SQLite (or PostgreSQL) because in-memory SQLite
  shares one connection and would hide the race.
