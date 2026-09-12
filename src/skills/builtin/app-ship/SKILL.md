---
name: app-ship
description: Make an app runnable from a clean clone and deployable from the files it ships — env example, health route, README Run section, one deploy target with the exact command, secrets out of the image. Use when asked to deploy, ship, release, containerise or "make it run in production".
author: aico
version: 1.0.0
trigger: \b(deploy|ship|release|containeri[sz]e|dockeri[sz]e|production|go live|publish the app|host (it|this|the app))\b
---
Ship what exists; do not rebuild it. The deliverable is an app that a stranger can run from a clean clone and a host can run from the files it carries. {args}

## 1. Runs from clean

In a scratch copy or with the profile's commands: `setup` (install), `typecheck`, `test`, `build`, then `start`. Every step must pass from a clean install. Fix what does not; that is the work. `RunChecks` runs the middle three.

## 2. Config is environment only

- `.env.example` lists every variable the code reads, with a comment each and no real values. Grep the code for `process.env.` / `os.environ` and reconcile.
- Nothing secret in code, in the image, or in a committed `.env`. `.gitignore` and `.dockerignore` both exclude `.env*` except the example.
- One setting for where data lives (`DATABASE_PATH` or a URL), defaulting to a path under the app, mountable as a volume.

## 3. A health route and a clean stop

- `GET /healthz` answers 200 fast; `/readyz` (or the same route) says whether the database answers. If the app has no such route, writing it is the first edit — the image's `HEALTHCHECK` means nothing without it.
- `SIGTERM` closes the server and the database; the process exits within ten seconds.
- The port comes from `PORT`; the bind address from `HOST`, default `0.0.0.0` in a container.

## 4. The image

A multi-stage Dockerfile: install with the lockfile, build, then a runtime stage with production dependencies only, a non-root user, `EXPOSE`, `HEALTHCHECK`, a `VOLUME` for data, `CMD` of the start command. `compose.yaml` runs it with the volume and the env. The files are the deliverable regardless of whether a build runs. If this is a bound app, `AppManage deploy` (target `docker`) builds it and reports pass or fail — that is the only way to build; never shell out to `docker build` yourself to check your own work, it is slow and not the point. No bound app, or Docker unavailable: say so and stop at the files.

## 5. README Run section

Exactly: how to run locally (three commands), how to configure (the table from `.env.example`), how to deploy (the command, then the URL to check). No prose about what the app is — that is the top of the README already.

## 6. Record it

`deploy/README.md` names the target and the exact command per host (Docker, then the hosts the Dockerfile fits). Append one line to `.aico/decisions.md` if a deployment choice was made (why SQLite on one replica, why this host). The profile records the deploy command once it has run.

## Do not

- Add a cloud SDK, a secrets manager, or credentials to the app to "make deploy easier".
- Change the app's behaviour to suit a host; change the config.
- Call it shipped without a passing run from clean and a health check answered.
- Retry the same failing command a third time. Two attempts is enough to tell whether the fix worked; a third is the same guess again. Say what failed and move to the next file.
