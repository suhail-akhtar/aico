---
name: app-platform
description: How aico's Apps platform works end to end — kinds, templates, the AppManage tool, the files every app carries, the workspace panel with live preview, checks and browser gates, deploy — so you build on it instead of around it. Read once when starting work on an app, or when a person asks how Apps work.
author: aico
version: 1.0.0
trigger: \b(how do (the )?apps work|apps platform|what is an app here|app system|mini ?apps?|explain (the )?apps|templates? available|which template)\b
---
Apps are real applications kept in the workspace under `<workspace>/miniapps/<slug>/`, started from templates, built by one agent, verified in a real browser, and deployable from the files they ship. This is the whole platform in one page. {args}

## Kinds (how an app runs)

- **page** — one screen over the shared SQLite host: `schema.sql` + `public/index.html`, no install. Data through `aico.db` and `x-data="resource(...)"`; never SQL from the page. Served at `http://127.0.0.1:<host port>/<slug>/`.
- **static** — files under `public/`, served by the same host. No database.
- **process** — its own server (Next.js, Hono, Astro…): `AppManage start` installs on first run, starts `run.dev` on a free port, waits for `run.ready`, and reports the URL.
- **cli** — nothing served; a passing `RunChecks` is the check.
- **mobile** — Expo; the web preview is what runs here.

## Templates (`AppManage templates`)

page-records · landing-static · api-service-hono · web-saas-next · dashboard-next · cli-node · docs-astro · agent-service-node · mobile-expo. Each copies in as files in zero model tokens with a worked feature, tests, `AICO.md` (notes for you, inlined into your prompt), `docs/EXTENDING.md` (the pattern to copy), `.aico/backlog.md`, `.aico/decisions.md`, `.aico/profile.json` (its commands, template rank), and for process/static kinds a Dockerfile, `compose.yaml`, `.env.example` and `deploy/`. User templates live in `~/.aico/templates/<id>/` and `<project>/.aico/templates/<id>/`.

## The tool: AppManage

`templates [brief]` ranks by the brief · `create name template [description]` copies and returns a ~150-token pointer (no template → the catalogue, nothing made; `kind: page` → the page authoring contract) · `describe` · `list` · `tables` (page apps) · `start` / `stop` / `status` · `deploy [target]` (runs the app's own script; refuses plainly when a tool is missing) · `delete` (refused for the app this conversation is about). In a conversation bound to an app, never `create` another.

## What a bound conversation gives you

Your system prompt carries the app's identity, its `AICO.md` and a two-level file list (stable, cached). The tail carries one `app_state` line: process state and URL, backlog progress, host status. The person sees the same app beside the chat in the **workspace panel**: a live **Preview** (phone / tablet / desktop), the **Backlog** with progress, **Decisions**, **Files** and **Logs**, and Start / Stop / Deploy / Open. What you write to `.aico/backlog.md` and `.aico/decisions.md` is what they read there — keep them current.

## The gates

- `RunChecks` runs the profile's `typecheck`, `lint`, `build`, `test`; the checks gate holds the turn until they are green after a source change.
- A source write under a process or static app registers a *served* artifact: the turn cannot end until `VerifyApp` passed against the app's origin after the last write. If the app is not running, `AppManage start` first. A page app is verified by its file URL; a cli never in a browser.
- Verify with checks named after the user's requirements ("mark an invoice paid"), one interaction each.

## The method

1. `app-plan`: three questions at most, `docs/PRD.md`, stories with *Done when* appended to `.aico/backlog.md`, mirrored into TodoWrite.
2. `app-architecture`: data model first, copy the worked feature's layout, one decision line per settled choice.
3. `app-design` before the first screen: the shell, the hierarchy, the states — a product, not an admin panel.
4. Build one story at a time; `RunChecks`; `AppManage start`; `VerifyApp`; tick the story.
5. `app-quality` before saying done; `app-ship` to make it deployable.

## Do not

- Guess the stack: `AICO.md` and the profile already say.
- Put SQL in a page app, or CDN scripts anywhere (the CSP forbids them).
- Delete an app to "reset" it; that deletes the person's data.
- Use a role-based team; `Investigate` is the only fan-out.
