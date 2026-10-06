# __APP_TITLE__

A JSON API: FastAPI, Pydantic v2, async SQLAlchemy 2, Alembic; Python 3.14, uv.
Runs as its own process; aico starts it with `uv run uvicorn` and waits for
"Uvicorn running on".

## Layout

- `src/app/main.py` — composition root: `create_app()`. One `include_router` per feature.
- `src/app/core/` — shared kernel (config, errors, security, pagination, middleware). Imports no feature.
- `src/app/db/` — base, session, `migrations/versions/` (append, never edit).
- `src/app/features/<name>/` — `models schemas repository service deps router`. **items is the worked example: copy it.** `auth` gives login and `CurrentUser`.
- `tests/{unit,integration,security,contract,property}`; `openapi.json` is committed.

## Conventions

- Router is thin; the service owns the commit; every repository query is scoped by `owner_id` (someone else's row is a 404).
- Raise `NotFoundError` etc. Every error is RFC 9457 problem+json. Never return ORM objects: use schemas with `extra="forbid"`.
- Config from env only (`.env.example`); startup fails on bad values. Never log or return secrets.
- `AUTH_MODE=local` (default) or `oidc`: behind a gateway the API verifies the provider's RS256 token itself (`core/oidc.py`), creates the user on first sight (`auth/provisioning.py`), and 404s register/login/refresh/logout. Needs `OIDC_ISSUER`, `OIDC_JWKS_URI`, `OIDC_AUDIENCE`.
- New table or column: change the model, `uv run alembic revision --autogenerate -m "..."`, review it, then `make openapi`.

## Checks

`RunChecks` runs format, lint, mypy --strict, pytest (85% gate). `make check` adds bandit and pip-audit.
Then `AppManage start` and `VerifyApp`: `/healthz`, `/docs`, then register, log in and POST `/v1/items` with the token.
