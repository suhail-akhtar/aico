# Deploying __APP_TITLE__

The service is a stateless container plus PostgreSQL. Everything it needs arrives as
environment variables, which is what lets one image run on every host below.

## Local, as production does it

```sh
cp .env.example .env            # set POSTGRES_PASSWORD and JWT_SECRET (openssl rand -hex 32)
docker compose up --build       # PostgreSQL, then the migration, then the API on :8000
curl localhost:8000/readyz
```

`node deploy/docker.mjs` builds just the image (`docker build -t __APP_SLUG__ .`).

## The image

- Multi-stage, base pinned by digest, non-root (uid 10001), no shell tools beyond the base.
- Run it read-only: `--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges`
  (compose does). It writes nothing.
- `HEALTHCHECK` calls `/healthz`. Orchestrators should use `/healthz` for liveness and
  `/readyz` for readiness.
- One process per container. Scale with replicas; `WEB_CONCURRENCY=N` runs N workers in one
  container if you must.
- `docker stop` sends SIGTERM: uvicorn stops accepting, finishes in-flight requests (up to
  20 s), then the engine closes its connections.

## Required environment in production

| Variable | Notes |
|---|---|
| `APP_ENV=production` | set by the image; refuses SQLite and a placeholder secret |
| `DATABASE_URL` | `postgresql+psycopg://user:password@host:5432/db` (URL-encode special characters) |
| `JWT_SECRET` | at least 32 random characters, from a secret manager, never in the image |
| `AUTH_MODE=oidc` | behind an identity provider: also set `OIDC_ISSUER`, `OIDC_JWKS_URI`, `OIDC_AUDIENCE`; `JWT_SECRET` is then not needed |
| `ALLOWED_ORIGINS` | the browser origins that may call the API; empty disables CORS |
| `FORWARDED_ALLOW_IPS` | your proxy's address, so client addresses (and rate limits) are right |

## Migrations

Run `python -m app.cli migrate` once per release, before starting the new version (compose's
`migrate` service, a Kubernetes `Job`, or a release-phase command). Do not set `AUTO_MIGRATE`
in production: replicas booting together would race.

## Hosts

| Host | Notes |
|---|---|
| Fly.io, Render, Railway | Point at the repo (they detect the Dockerfile); attach managed PostgreSQL; set the variables above; run the migration as the release command. |
| A VPS | `docker compose up -d` behind Caddy or nginx for TLS; set `FORWARDED_ALLOW_IPS` to the proxy. |
| Kubernetes / ECS | Deployment with the two probes, a migration `Job`, the secret from the platform's secret store, `terminationGracePeriodSeconds` above 20. |

## Checklist before going live

- `make check` and `make test-pg` pass from a clean clone; the image smoke test answers
  `/healthz` and `/readyz`.
- Backups are on and a restore has been tried.
- TLS terminates in front of the container; `FORWARDED_ALLOW_IPS` is set.
- `DOCS_ENABLED=false` if the API is not public (`/openapi.json` stays; put the proxy in front
  of it if that matters).
- Logs are collected (JSON on stdout) and an alert exists on 5xx rate and `/readyz`.
- You have read `SECURITY.md`, "What it does not do".
