# Deploying __APP_TITLE__

The deployable is one container image. Build it with the Deploy button, or:

```
docker build -t api-service:latest .
```

It listens on 8080 (`PORT`), runs as uid 10001, needs a writable `/tmp` only, and stops cleanly on
SIGTERM (20 second drain; give the orchestrator a longer grace period).

## Required environment

| Variable | Notes |
|---|---|
| `DATABASE_URL` | e.g. `jdbc:postgresql://db:5432/app` (add `?sslmode=require` for a managed database) |
| `DATABASE_USER`, `DATABASE_PASSWORD` | from your secret store |
| `APP_JWT_SECRET` | local mode (default): 32+ characters, from your secret store; rotating it signs everyone out. Not used in oidc mode |
| `APP_AUTH_MODE`, `OIDC_ISSUER`, `OIDC_JWKS_URI`, `OIDC_AUDIENCE` | `APP_AUTH_MODE=oidc` to verify an external provider's tokens (README: "Run behind an OIDC gateway"); the three `OIDC_*` are then required |
| `APP_CORS_ALLOWED_ORIGINS` | the browser origins of your front end, if any |

Flyway applies the migrations on start, so the database user needs DDL rights, or run the
migration as a separate step with a privileged user and give the application a limited one.

## Probes

- Liveness: `GET /healthz` (no dependencies).
- Readiness: `GET /readyz` (database reachable). Use it to gate traffic.
- Allow roughly 40 seconds for the first start (`start-period` in the Dockerfile healthcheck).

## Checklist

- TLS terminates in front (HSTS is sent, but only means something over HTTPS).
- Rate limiting is per instance; with several replicas, also limit at the gateway.
- Behind a proxy, configure `server.forward-headers-strategy` only if you control the proxy. Behind a
  gateway that terminates users (oidc mode) do set it (`SERVER_FORWARD_HEADERS_STRATEGY=native`),
  or every user shares the gateway's rate-limit bucket.
- The API explorer is off in the image; set `APP_DOCS_ENABLED=true` only on trusted networks.
- Telemetry: `APP_OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT`.

Local stack with PostgreSQL: `make run` (compose). Release steps: `docs/RELEASING.md`.
