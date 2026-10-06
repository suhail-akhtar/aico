# Deploying __APP_TITLE__

The app is static files plus a ten-line nginx config, in a container. It holds no state and no
secret. What it needs arrives as environment variables, and what it needs from the outside is a
gateway that serves `/api` and `/api/auth/*` on the same origin (`docs/BFF.md`).

## Build and run

```sh
node deploy/docker.mjs        # docker build -t __APP_SLUG__ .
docker run --rm -p 8080:8080 --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges __APP_SLUG__
curl localhost:8080/healthz
```

## The image

- Multi-stage, both bases pinned by version and digest, non-root (uid 101), read-only root filesystem.
- `HEALTHCHECK` calls `/healthz`. Use it for liveness and readiness (there is no dependency to wait for).
- `/config.json` is written at start from the environment, so one image runs in every environment:

  | Variable | Default | Notes |
  |---|---|---|
  | `API_BASE_URL` | `/api` | a path on this origin; anything else stops the container (exit 64) |
  | `LOGIN_URL` | `/api/auth/start` | gateway endpoint; the app appends `rd=<return path>` |
  | `LOGOUT_URL` | `/api/auth/sign_out?rd=/` | gateway endpoint |
  | `APP_ENVIRONMENT` | `production` | a label for bug reports |

- Cache headers: `index.html` and `/config.json` are never cached; `/assets/*` are fingerprinted and
  cached for a year. A new release is picked up on the next navigation.
- Source maps are deleted from the image. Upload them to your error tracker in CI first.

## Behind a gateway

Route `/` to this container and `/api/*` to the gateway's API side, on one origin. The full-stack AICO
bundles do exactly that with Traefik. If TLS ends at the gateway, set `Strict-Transport-Security` there
and make the session cookie `Secure`.

## Checklist before going live

- `make check` and `make e2e` pass from a clean clone; the CI image job's smoke test is green.
- The gateway enforces the CSRF header on unsafe methods and returns 401 (not a redirect) to API calls without a session.
- `E2E_BASE_URL=https://staging... npm run e2e` passes against the real stack.
- You have read `SECURITY.md`, "What it does not do".
