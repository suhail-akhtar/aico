# Deploying __APP_TITLE__

One image runs everywhere: `docker build -t __APP_SLUG__ .` (or `make build`). It is a
multi-stage build (Node compiles the CSS/JS and is then discarded; Composer installs without
dev packages; the runtime is FrankenPHP, i.e. Caddy and PHP in one process). The container
listens on **8080**, runs as uid 10001 with a **read-only root filesystem**, needs only a
tmpfs at `/tmp`, and answers `/healthz` (liveness, no database) and `/readyz` (readiness,
checks PostgreSQL). TLS is terminated in front of it.

## Required environment

| Variable | Notes |
|---|---|
| `APP_KEY` | 32 random bytes, `base64:` prefixed: `docker run --rm __APP_SLUG__ php artisan key:generate --show`. Never in the image. |
| `APP_ENV=production`, `APP_DEBUG=false` | The default in the image. The container refuses to start with debug on. |
| `APP_URL` | The public https URL. |
| `DB_CONNECTION=pgsql`, `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD` | PostgreSQL 16+ (tested on 18). |
| `TRUSTED_PROXIES` | Your proxy's IP/CIDR (or `*` only if the app is reachable solely through it). |
| `CORS_ALLOWED_ORIGINS` | Exact origins that may call the API from a browser (empty = none). |
| `MAIL_*` | A real SMTP provider. |

Run the migrations once per release as a separate step (`php artisan migrate --force`; compose
has a `migrate` service for that), never from the web process. Run **one** `queue:work` and
**one** `schedule:work` container from the same image (see `compose.yaml`).

## Hosts

| Host | Notes |
|---|---|
| Docker Compose on a VPS | `docker compose up -d` behind Caddy or Traefik for TLS. Remove `SESSION_SECURE_COOKIE: "false"` from `compose.yaml` once TLS is in front. |
| Fly.io | `fly launch` reads the Dockerfile; set internal port 8080; `fly secrets set APP_KEY=... DB_PASSWORD=...`; release command `php artisan migrate --force`; `fly mpg` or Neon for PostgreSQL. |
| Render / Railway | Dockerfile detected; add their managed PostgreSQL; add a background worker service with `php artisan queue:work`. |
| Kubernetes / ECS | Deployment (`app`), a second Deployment (`queue`), a CronJob or one-replica Deployment (`scheduler`), a Job (`migrate`) before rollout; liveness `/healthz`, readiness `/readyz`; `readOnlyRootFilesystem: true`, an `emptyDir` at `/tmp`. |

## Before going live

- `make check` and `make smoke` pass from a clean clone; CI is green on the exact commit.
- `APP_KEY` and `DB_PASSWORD` come from a secret store, not the repository.
- TLS in front; HSTS is sent automatically over HTTPS; `SESSION_SECURE_COOKIE` is true.
- Sign-up policy decided (open, invite-only, or closed after the first user).
- Backups for PostgreSQL, and a restore you have actually tried.
- `API_DOCS_ENABLED` is false unless you mean to publish the OpenAPI document.
