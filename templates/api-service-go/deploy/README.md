# Deploying __APP_TITLE__

The service is a stateless container plus PostgreSQL. Everything it needs arrives as environment
variables, which is what lets one image run on every host below.

## Local, as production does it

```sh
cp .env.example .env            # set POSTGRES_PASSWORD (openssl rand -hex 24), or: make setup
docker compose up --build       # PostgreSQL, then the migrations, then the API on :8080
curl localhost:8080/readyz
```

`node deploy/docker.mjs` builds just the image (`docker build --target runtime -t __APP_SLUG__ .`).

## The image

- Three stages in the Dockerfile (tools, build, runtime); every base is pinned by version and digest.
  The runtime is `gcr.io/distroless/static-debian13:nonroot`: one static binary, no shell, no package
  manager, uid 65532.
- Run it read-only: `--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges`
  (compose does). The service writes nothing to disk.
- `HEALTHCHECK` runs `/server healthcheck`, which requests `/healthz` (distroless has no curl).
  Orchestrators should use `/healthz` for liveness and `/readyz` for readiness; readiness turns 503
  the moment shutdown begins so the load balancer drains first.
- `docker stop` sends SIGTERM: the server stops accepting, finishes in-flight requests (up to
  `SHUTDOWN_TIMEOUT`, default 20 s), closes the pool and exits 0. Keep the orchestrator's
  termination grace period longer than that.
- The binary is stamped at build time: `docker build --build-arg VERSION=1.2.3 --build-arg COMMIT=$(git rev-parse --short HEAD) ...`.
  `server version` and the `starting` log line report it.

## Required environment in production

| Variable | Notes |
|---|---|
| `APP_ENV=production` | set by the image; adds HSTS, refuses `seed` |
| `DATABASE_URL` | `postgres://user:password@host:5432/db?sslmode=verify-full` (percent-encode special characters); the service warns if production uses `sslmode=disable` |
| `CORS_ALLOWED_ORIGINS` | the browser origins that may call the API; empty disables CORS |
| `ARGON2_MEMORY_KIB` | default 64 MiB per concurrent login (at most 2 to 8 at once): size the container memory for it, or lower it (floor 19456) |

## Migrations

`MIGRATE_ON_START=true` (default) applies pending migrations at boot under a PostgreSQL advisory lock, so
several replicas starting together are safe: one migrates, the others wait. For a stricter pipeline set
`MIGRATE_ON_START=false` and run `server migrate` as a release step; the server then refuses to start while
migrations are pending. Migrations are forward-only in production: write each so the previous version still
works against the new schema.

## Hosts

| Host | Notes |
|---|---|
| Fly.io | `fly launch` reads the Dockerfile (`target = "runtime"`); attach Fly Postgres or a managed one; set `DATABASE_URL` as a secret; internal port 8080; health check `/healthz`. |
| Render / Railway | Point at the repo; set `DATABASE_URL`, `APP_ENV=production`; health check path `/readyz`. |
| VPS | `docker compose up -d` behind Caddy or nginx for TLS; keep PostgreSQL's port unpublished. |
| Kubernetes / ECS | `readOnlyRootFilesystem: true`, `runAsNonRoot: true`, probes on `/healthz` and `/readyz`, a managed PostgreSQL or CloudNativePG, secrets as env from a secret manager. |

## Checklist before going live

- `make check` and `sh scripts/smoke.sh` pass from a clean clone, and CI is green on the commit you deploy.
- `DATABASE_URL` uses TLS (`sslmode=verify-full`) and a least-privilege database role.
- `CORS_ALLOWED_ORIGINS` lists real origins only; TLS terminates in front of the container.
- Rate limits are per replica and use the peer address: put the real limit at the gateway when behind a proxy
  (`docs/ARCHITECTURE.md`, Stage 2).
- Backups of PostgreSQL exist and a restore has been rehearsed.
- Authentication decided (`.aico/backlog.md`, Iteration 1) and tested.
