# Where a Dockerfile runs

One stateless process, one volume for data, config from env. That is what makes the same image run on every host below.

| Host | What to do |
|---|---|
| Docker (any VPS) | `docker build -t <slug> .` then `docker run -p 3000:3000 -v <slug>-data:/app/data -e SESSION_SECRET=… <slug>`; `docker compose up -d` does the same with `compose.yaml`. Put Caddy or nginx in front for TLS. |
| Fly.io | `fly launch` reads the Dockerfile; add `[mounts] source="data" destination="/app/data"`; `fly secrets set` for each secret. |
| Render / Railway | Point at the repo; the Dockerfile is detected; attach a persistent disk at `/app/data`; set env in the dashboard. |
| Kubernetes / ECS | One replica while on SQLite (a single writer); liveness `/healthz`, readiness `/readyz`; a PVC or EFS at `/app/data`. |
| Vercel / serverless | Only after moving the data layer to Postgres — a SQLite file does not survive between invocations. |
| Static hosts (Netlify, Pages, S3) | For `static` apps: publish `public/` as-is; no build command. |

## Scaling past one replica

SQLite means one writer. Move to Postgres by swapping the data module (the routes and tests should not change), then remove the volume and raise replicas.

## Secrets

`SESSION_SECRET` (or the equivalent) is long, random, set per environment, and rotating it signs everyone out. Never in the image, never in the repo, always in `.env.example` as a name with a comment.

## The checklist before "shipped"

- `setup`, `typecheck`, `test`, `build`, `start` pass from a clean clone.
- `.env.example` matches every `process.env` read.
- `/healthz` answers in the container.
- The README's Run section is three commands and a table.
- `deploy/README.md` names the command for the target actually used.
