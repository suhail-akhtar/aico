# Deploying __APP_TITLE__

The service is a stateless container plus a PostgreSQL database. Configuration is environment only, which is what
lets one image run on every host below. The image is distroless (no shell), runs as a non-root user, listens on 8080
and tolerates a read-only root filesystem.

## Docker (any host)

```sh
node deploy/docker.mjs                       # docker build -t __APP_SLUG__ .
docker run --rm -e ConnectionStrings__Default="Host=...;Database=...;Username=...;Password=..." \
  -e Jwt__SigningKey="$(openssl rand -base64 48)" __APP_SLUG__ --migrate     # once per release
docker run -d -p 8080:8080 --read-only --tmpfs /tmp --cap-drop ALL \
  -e ConnectionStrings__Default="..." -e Jwt__SigningKey="..." __APP_SLUG__
curl localhost:8080/healthz
```

`compose.yaml` shows the same shape with PostgreSQL included: `cp .env.example .env && docker compose up --build`.

## The release order

1. Run `--migrate` with the **new** image against the production database (a one-shot job: init container, release
   phase, CI step). EF takes the provider's advisory lock, so two runs cannot collide.
2. Start the new version. Migrations are backward compatible with the previous version for one release, so a rollback
   of the service never meets a schema it cannot read.

## Hosts

| Host | Notes |
|---|---|
| Fly.io, Render, Railway | Point at the repository (Dockerfile detected), set the two secrets and a managed PostgreSQL URL, run `--migrate` as the release command. They set `PORT`; the service honours it. |
| Azure Container Apps, Cloud Run, ECS | One container, port 8080, probes `/healthz` (liveness) and `/readyz` (readiness), a managed PostgreSQL, secrets from the platform's store. |
| Kubernetes | A Deployment with the two probes, a `Job` (or Helm hook) running `--migrate`, secrets from a Secret. Use `readOnlyRootFilesystem: true` and an `emptyDir` on `/tmp`. |
| VPS | `docker compose up -d` behind Caddy or nginx for TLS. |

## Behind a proxy or load balancer

TLS ends at the proxy. Set `ForwardedHeaders__Enabled=true` and `ForwardedHeaders__KnownNetworks` to the proxy's CIDR so
rate limits and logs see the client address; without it every client shares the proxy's address. Send HSTS from the
proxy. Set `Cors__AllowedOrigins` to your front end's exact origin.

## Scaling

The service holds no state: run as many replicas as you like. The rate limiter is per instance (put a gateway or a
distributed limiter in front for a global budget). Refresh tokens live in PostgreSQL, so any replica can rotate them.

## Checklist before going live

- `make check` passes from a clean clone and CI is green on the commit being released.
- `Jwt__SigningKey` is a random value, not the placeholder; the service refuses to start otherwise (local mode). Behind an
  identity provider set `AUTH_MODE=oidc`, `OIDC_ISSUER`, `OIDC_JWKS_URI` and `OIDC_AUDIENCE` instead (README); run the `--migrate`
  job with the same variables, since it validates the whole configuration first.
- `/readyz` answers 200 with the production database; `docker stop` shuts down within the platform's grace period.
- Backups for PostgreSQL exist and a restore has been tried.
- The decisions in `.aico/decisions.md` ("Honest limits": lockout, verification, reset, MFA) are made on purpose.
