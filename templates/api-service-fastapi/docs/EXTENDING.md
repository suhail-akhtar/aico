# Extending this service

## Add a resource (the main move)

Copy `src/app/features/items/` to `src/app/features/orders/` and rename inside it.

1. **Model** (`models.py`): `Order` with a `UUID` primary key from `new_id()`, an
   `owner_id` foreign key, real constraints (`CheckConstraint`, `ForeignKey(..., ondelete=)`),
   and an index that serves the list query.
2. **Migration**: `uv run alembic revision --autogenerate -m "add orders"` (reads the same
   settings as the app; point `DATABASE_URL` at a throwaway SQLite file). Open the file and
   read it: autogenerate misses renames and some constraint changes. Name it
   `0002_add_orders.py`. Never edit a migration that has shipped; add another.
3. **Schemas** (`schemas.py`): `OrderInput` (what a client may send, `extra="forbid"`, strict)
   and `OrderRead`. The owner is not a field of either.
4. **Repository**: every method takes `owner_id` and puts it in the `WHERE`.
5. **Service**: owns the use case and the `commit()`. Raise `NotFoundError` when the repository
   returns nothing. This is where business rules go.
6. **Router + deps**: thin. Mount it with one line in `main.py`:
   `app.include_router(orders.router, prefix=API_PREFIX, dependencies=default_limit)`.
7. **Import the model in `src/app/db/migrations/env.py`** (one line, like the others) so
   autogenerate and the drift test see it.
8. **Contract**: `make openapi`, and add the new routes to the list in
   `tests/contract/test_openapi.py` (it is the API's public surface; adding a route is deliberate).
9. **Tests**: copy `tests/integration/test_items.py`; add the cross-user cases from
   `tests/security/test_authorization.py` for the new routes.
10. `make check`.

## Add a column

Change the model, autogenerate a migration, give a new `NOT NULL` column a `server_default`
(or backfill in the migration) so it applies to existing rows, then update the schemas,
`make openapi`, and add a test. `tests/integration/test_migrations.py` fails if the model
and the migrations disagree.

## Protect a route differently

- Any signed-in user: add `user: CurrentUser` to the handler (see `items`).
- A role or scope: add a column or claim, then a dependency such as
  `def require_admin(user: CurrentUser) -> User: ...` raising `ForbiddenError`, and
  `Depends(require_admin)` on the route. Test both the 403 and the 401.
- A tighter rate limit: `dependencies=[Depends(RateLimit("auth"))]` on the route, or add a
  new kind in `core/deps.py`.

## Call another service

Use `httpx.AsyncClient` with an explicit `timeout=`, owned by the composition root (add it to
`Container`), and retry only idempotent calls with bounded, jittered backoff. A call with no
timeout is a request that can hold a worker forever. Never forward the caller's token unless
that is the point; never put user input in the URL without validating it. If you fetch
URLs a user supplies, block loopback, link-local and metadata addresses (SSRF).

## Background work

`BackgroundTasks` runs after the response in the same process and is lost on a crash: fine
for "send an analytics event", wrong for "charge the customer". For work that must happen,
write a row in the same transaction (an outbox table) and have a worker process publish it;
see `ARCHITECTURE.md`, stage 2.

## Move to an identity provider

At medium scale and above, prefer OIDC (Keycloak, Entra ID, Auth0) over local passwords. This
starter already does it: set `AUTH_MODE=oidc` with `OIDC_ISSUER`, `OIDC_JWKS_URI` and
`OIDC_AUDIENCE` (README, "Run behind an OIDC gateway"). `CurrentUser` stays the seam:
`get_current_user` in `features/auth/deps.py` calls `core/oidc.py` (RS256 pinned, JWKS cached
and rate-limited, `iss`/`aud`/`exp`/`nbf`/`sub` checked) and `features/auth/provisioning.py`
creates the user row on first sight. Routes and the tests of every other feature do not change.

What is left for you, in order of how often it comes up:

- **Roles and scopes**: read the claim (Keycloak: `realm_access.roles`, or a client-role
  mapper) in `OidcIdentity`, carry it to a `require_role("admin")` dependency that raises
  `ForbiddenError`, and test the 401, the 403 and the 200.
- **Email changes**: the row's email is captured at first sight and not re-synced. To follow the
  provider, update it in `provision_user` for a known subject, with the same collision rule
  (409, never a merge).
- **Retiring local accounts for good**: delete `register`, `login`, `refresh`, `logout`,
  `RefreshToken`, `TokenService` and `JWT_SECRET`, then regenerate `openapi.json`. Until then
  `AUTH_MODE=local` still works for standalone use.
- **Another provider**: nothing Keycloak-specific is in the code. A provider that signs with
  ES256 needs `ALGORITHM` and `_parse_keys` in `core/oidc.py` widened together, and a test.

## Switch to cookie sessions (browser-only front end)

Tokens in `localStorage` are readable by any script on the page. If your only client is a web
front end you control, a server-side session in an `HttpOnly; Secure; SameSite=Lax` cookie
behind a backend-for-frontend is safer, but it needs CSRF protection (`Origin` check or a
double-submit token) which bearer tokens do not. This template chose bearer tokens because it
serves mobile and third-party clients too (`.aico/decisions.md`).

## What not to do

- No SQL strings built from input. Use the SQLAlchemy expression API; bind every value.
- No `owner_id` in a request schema, and no query without it.
- No catching `Exception` to return a 200; let the handlers turn errors into problem responses.
- No secrets in code, tests, `.env.example`, or the image; environment only.
- No `print` or f-string logging: `structlog.get_logger().info("event.name", key=value)`.
- No blocking calls (`time.sleep`, `requests`, sync database drivers) in `async def` handlers;
  use `asyncio.to_thread` for CPU-bound work, as password hashing does.
- No edits to a shipped migration, and no `Base.metadata.create_all` outside tests.
