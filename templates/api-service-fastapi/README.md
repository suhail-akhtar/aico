# __APP_TITLE__

__APP_DESCRIPTION__

A JSON API on [FastAPI](https://fastapi.tiangolo.com): Pydantic v2 validation, async
SQLAlchemy 2, Alembic migrations, PostgreSQL in production and SQLite for a zero-setup
start, Argon2id passwords, short-lived JWTs with rotating refresh tokens, RFC 9457 errors,
structured logs, rate limits, and a hardened container. One worked resource (`items`) to
copy. Tested at the unit, integration, security, property-based and contract level. Runs
standalone with its own accounts, or as an OIDC resource server behind an identity provider
(`AUTH_MODE=oidc`).

## Run

You need [uv](https://docs.astral.sh/uv/) (it installs Python 3.14 for you).

```sh
cp .env.example .env     # set JWT_SECRET: openssl rand -hex 32
uv sync --locked
make seed                # optional: demo@example.com with a few items
make dev                 # http://localhost:8000, reloads on change
```

Open <http://localhost:8000/docs>. Without `make`: `uv run uvicorn app.main:create_app --factory --reload`.

```sh
curl -s -X POST localhost:8000/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"a long passphrase"}'
TOKEN=$(curl -s -X POST localhost:8000/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"a long passphrase"}' | python -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
curl -s -X POST localhost:8000/v1/items -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"pen","quantity":3}'
curl -s localhost:8000/v1/items -H "authorization: Bearer $TOKEN"
```

| Route | What |
|---|---|
| `GET /healthz` | liveness: the process is up, no dependencies touched |
| `GET /readyz` | readiness: the database answers (503 if not) |
| `POST /v1/auth/register` `login` `refresh` `logout`, `GET /v1/auth/me` | accounts and sessions (the four `POST`s are 404 with `AUTH_MODE=oidc`) |
| `POST/GET /v1/items`, `GET/PUT/DELETE /v1/items/{id}` | the worked resource |
| `GET /docs`, `GET /openapi.json` | interactive docs, the contract |

## Check

```sh
make check      # format, lint (ruff + bandit), mypy --strict, tests with an 85% gate, pip-audit
make test       # just the tests, on SQLite, in about 30 seconds
make test-pg    # the same tests against PostgreSQL (needs Docker)
```

| Verb | Does |
|---|---|
| `setup` `dev` `run` | install, run with reload, run like production |
| `fmt` `fmt-check` `lint` `typecheck` | ruff format, ruff + bandit, mypy |
| `test` `cov` `test-pg` | tests, with the coverage gate, against PostgreSQL |
| `audit` `sbom` | dependency vulnerabilities, CycloneDX SBOM |
| `build` `check` | container image, everything CI runs |
| `openapi` `migrate` `seed` | regenerate `openapi.json`, apply migrations, demo data |

## Configure

Environment only (`.env` for local use); `.env.example` lists every variable with its
default. The service refuses to start on a bad value.

| Variable | Default | Meaning |
|---|---|---|
| `AUTH_MODE` | `local` | `local`: own accounts and tokens. `oidc`: verify an identity provider's tokens (below) |
| `JWT_SECRET` | required when `local` | signing key, at least 32 characters; not used in `oidc` mode |
| `OIDC_ISSUER` `OIDC_JWKS_URI` `OIDC_AUDIENCE` | required when `oidc` | the exact `iss`, where the signing keys are, the required `aud` |
| `DATABASE_URL` | local SQLite file in development | `postgresql+psycopg://user:pw@host/db` in production |
| `APP_ENV` | `development` | `production` demands PostgreSQL and a real secret |
| `ALLOWED_ORIGINS` | none | comma-separated browser origins for CORS; never `*` |
| `RATE_LIMIT_AUTH` / `RATE_LIMIT_DEFAULT` | `10/minute` / `120/minute` | per address, per process |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | off | set to send traces, metrics and logs over OTLP |

## Run behind an OIDC gateway

For a single-page app behind a gateway (Traefik and oauth2-proxy, an API gateway) with an
identity provider such as Keycloak, the service is a plain OIDC resource server: the gateway
forwards `Authorization: Bearer <access token>` and the API verifies it itself.

```sh
AUTH_MODE=oidc
OIDC_ISSUER=http://localhost:8080/idp/realms/app            # the exact `iss` in the tokens
OIDC_JWKS_URI=http://keycloak:8080/idp/realms/app/protocol/openid-connect/certs   # internal URL
OIDC_AUDIENCE=app-api                                        # required `aud` (a provider audience mapper)
```

- It refuses to start without those three (the error names the missing one); `JWT_SECRET` is
  not needed. `OIDC_JWKS_URI` is a separate URL on purpose: the key endpoint is usually an
  internal address, not the public issuer.
- Only RS256 is accepted (never `none` or HS256). Signature, `iss`, `aud`, `exp`, `nbf` (at most
  60 s of skew) and a UUID `sub` are all checked in this process, whatever the gateway did.
  Bad tokens are the ordinary 401 problem document; the reason goes to the log.
- The first valid token for a `sub` creates the user (id = `sub`, email from the `email` claim,
  lower-cased, or `<sub>@oidc.invalid`). If another account already owns that email the answer
  is 409 `identity-conflict`; accounts are never merged.
- `register`, `login`, `refresh` and `logout` answer 404 (`Local authentication is disabled:
  AUTH_MODE=oidc`), the demo seed is skipped, `/auth/me`, items, `/healthz` and `/readyz`
  work as before.
- Set `FORWARDED_ALLOW_IPS` to the gateway's address, or every request shares the gateway's
  IP and the per-address rate limits count them together.

## Deploy

`deploy/README.md`. In short: `docker compose up --build` runs PostgreSQL, the migration
and the API locally exactly as production does; the image is non-root and read-only.

## Structure

```
src/app/main.py        composition root: create_app()
src/app/core/          shared kernel: config, errors, security, pagination, middleware, logging
src/app/db/            declarative base, session, migrations
src/app/features/      items (the worked example), auth, users, health
tests/                 unit, integration, security, property, contract
openapi.json           the committed API contract
docs/                  ARCHITECTURE, EXTENDING, RELEASING
.aico/                 backlog and decisions
```

## Licence

MIT, see `LICENSE`. This is your code: change the licence line if your project needs another.
