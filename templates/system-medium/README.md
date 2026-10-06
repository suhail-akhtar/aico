# __APP_TITLE__

A complete small system you can run on one machine and grow: a React app, a Spring Modulith API, an
identity provider, a database, a cache, object storage, feature flags, mail, and a gateway that puts
them behind one address.

```
make setup                           # writes .env with random secrets, installs web dependencies
docker compose up --build --wait     # or: make dev
```

| What | Where |
|---|---|
| The app | http://localhost:8080 (sign in as `alice`, admin, or `bob`, member) |
| Keycloak (identity) | http://idp.localhost:8180 (admin console: user `admin`, password `KEYCLOAK_ADMIN_PASSWORD`) |
| Mailpit (every email sent) | http://localhost:8025 |
| API explorer (local only) | http://localhost:8080/swagger-ui/index.html |

The dev users' password is `DEV_USER_PASSWORD` from `.env`. `idp.localhost` resolves to your own
machine in browsers; if yours does not, add `127.0.0.1 idp.localhost` to your hosts file.

## What is in it

- **`services/web`**: React 19 + Vite, cookie session (the API signs you in, the browser never holds a
  token), tasks, attachments, an admin view of every task and the audit trail.
- **`services/api`**: Spring Boot 4, Spring Modulith modules `tasks`, `identity`, `audit`,
  `notifications`, `shared`. Assigning a task writes an event in the same transaction; a listener
  mails the assignee after commit and retries from the outbox if SMTP is down. A `worker` container
  (same image, jobs switched on) republishes stuck events and purges old ones.
- **`infra/`**: Traefik routes, the Keycloak realm (clients, roles, dev users), the PostgreSQL init
  script (two databases, two roles), flagd flags, the SeaweedFS entrypoint.

## Checks

```
make check                                                   # everything CI runs
cd services/api && ./mvnw verify                             # unit + integration tests (Docker), coverage gate, SpotBugs
cd services/web && npm run check                             # format, lint, types, tests, audit, build
docker compose up --build --wait && node scripts/smoke.mjs  # sign in, task, outbox mail, audit
```

Before this is real you must: put it behind TLS, replace the `start-dev` Keycloak with `start` and a
real hostname, remove the dev users from the realm, and move secrets to a secret store (see
[SECURITY.md](SECURITY.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

Licence: MIT.
