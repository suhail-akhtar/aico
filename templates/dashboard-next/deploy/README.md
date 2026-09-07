# Deploying __APP_TITLE__

A stateless Next.js server plus one SQLite file; config from env. One image runs on every host below.

## Docker (any host)

```sh
node deploy/docker.mjs                          # docker build -t __APP_SLUG__ .
docker run --rm -p 3000:3000 -v __APP_SLUG__-data:/app/data __APP_SLUG__
curl localhost:3000/api/healthz
```

`compose.yaml` does the same with a named volume. Mount `/app/data` or the metrics are lost with the container.

## Hosts

| Host | Notes |
|---|---|
| Fly.io | `fly launch`; `[mounts] source="data" destination="/app/data"`. |
| Render / Railway | Dockerfile detected; persistent disk at `/app/data`. |
| VPS | `docker compose up -d` behind Caddy for TLS. |
| Kubernetes / ECS | One replica while on SQLite; liveness `/api/healthz`; PVC at `/app/data`. |
| Vercel | Only after moving the metrics table to Postgres; SQLite on disk does not survive between invocations. |

## Before going live

- `npm run typecheck && npm run lint && npm test && npm run build` pass from a clean clone.
- The ingest route is protected (a bearer token checked in `src/app/api/metrics/route.ts`) or reachable only from inside your network.
- `seedSample` removed once real data flows.
