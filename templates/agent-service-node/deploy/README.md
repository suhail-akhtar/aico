# Deploying __APP_TITLE__

A stateless Node process plus one SQLite file, configured by env. One image runs on every host below.

## Docker (any host)

```sh
node deploy/docker.mjs
docker run --rm -p 3000:3000 -e MODEL_API_KEY=… -e MODEL=gpt-4o-mini \
  -v __APP_SLUG__-data:/app/data __APP_SLUG__
curl localhost:3000/healthz
```

`compose.yaml` refuses to start without `MODEL_API_KEY` in `.env`. Mount `/app/data` or the conversations are lost with the container.

## Hosts

| Host | Notes |
|---|---|
| Fly.io | `fly launch`; `fly secrets set MODEL_API_KEY=…`; `[mounts] source="data" destination="/app/data"`. |
| Render / Railway | Dockerfile detected; set the three MODEL variables; attach a disk at `/app/data`. |
| VPS | `docker compose up -d` behind Caddy for TLS. |
| Kubernetes / ECS | One replica while on SQLite; liveness `/healthz`, readiness `/readyz`; the key as a secret. |

## Before going live

- Auth on the message route (see `docs/EXTENDING.md`); an open LLM endpoint is a bill anyone can run up.
- A rate limit per client, and `maxSteps` kept low.
- The key is a secret on the host, never in the image.
