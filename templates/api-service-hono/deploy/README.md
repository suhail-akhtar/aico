# Deploying __APP_TITLE__

The service is a stateless Node process plus one SQLite file. Config is
environment only. That is what lets one image run on every host below.

## Docker (any host)

```sh
node deploy/docker.mjs                      # docker build -t __APP_SLUG__ .
docker run --rm -p 3000:3000 -v __APP_SLUG__-data:/app/data __APP_SLUG__
curl localhost:3000/healthz
```

`compose.yaml` does the same with a named volume: `docker compose up -d`.

**Mount `/app/data`.** Without a volume the database lives in the container
and is lost when it is replaced.

## Hosts

| Host | Notes |
|---|---|
| Fly.io | `fly launch` reads the Dockerfile; add `[mounts] source="data" destination="/app/data"`; set `PORT=3000` in `[env]`. |
| Render / Railway | Point at the repo; both detect the Dockerfile; attach a persistent disk at `/app/data`. |
| VPS | `docker compose up -d` behind Caddy or nginx for TLS. |
| Kubernetes / ECS | One replica while on SQLite (a single writer). Health probe `/healthz`, readiness `/readyz`, PVC/EFS at `/app/data`. |

## Scaling past one replica

SQLite means one writer. When you need more, swap `src/db.ts` for Postgres
(`docs/EXTENDING.md`, "Move to Postgres"); routes and tests stay as they are.

## Checklist before going live

- `npm run typecheck && npm test && npm run build` pass from a clean clone.
- `.env.example` lists every variable the code reads; none is in the image.
- `/readyz` answers 200 with the real database path mounted.
- Auth decided and tested (`docs/EXTENDING.md`, "Add auth").
