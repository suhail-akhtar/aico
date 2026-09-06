# Deploying __APP_TITLE__

A stateless Next.js server plus one SQLite file. Config is environment only:
`SESSION_SECRET` (required) and `DATABASE_PATH`. One image runs everywhere below.

## Docker (any host)

```sh
node deploy/docker.mjs                                   # docker build -t __APP_SLUG__ .
docker run --rm -p 3000:3000 -e SESSION_SECRET=$(openssl rand -hex 32) \
  -v __APP_SLUG__-data:/app/data __APP_SLUG__
curl localhost:3000/api/healthz
```

`compose.yaml` does the same and refuses to start without `SESSION_SECRET` in
`.env`. **Mount `/app/data`** or the database is lost with the container.

## Hosts

| Host | Notes |
|---|---|
| Vercel | Works for the pages, but SQLite on disk does not survive between invocations. Move the data layer to Postgres first (`docs/EXTENDING.md`). |
| Fly.io | `fly launch` reads the Dockerfile; `[mounts] source="data" destination="/app/data"`; `fly secrets set SESSION_SECRET=…`. |
| Render / Railway | Dockerfile detected; add a persistent disk at `/app/data`; set `SESSION_SECRET`. |
| VPS | `docker compose up -d` behind Caddy for TLS. Cookies are `Secure` in production, so TLS is required. |
| Kubernetes / ECS | One replica while on SQLite; liveness `/api/healthz`; PVC or EFS at `/app/data`. |

## Checklist before going live

- `npm run typecheck && npm test && npm run build` pass from a clean clone.
- `SESSION_SECRET` is long, random, and not in the repo. Rotating it signs everyone out.
- TLS in front (cookies are `Secure` when `NODE_ENV=production`).
- Sign-up policy decided: open, invite-only, or disabled after the first user.
