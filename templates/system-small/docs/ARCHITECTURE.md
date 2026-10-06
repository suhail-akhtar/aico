# Architecture

## Request flow (one origin)

```mermaid
sequenceDiagram
  participant B as Browser
  participant T as Traefik
  participant O as oauth2-proxy
  participant K as Keycloak
  participant A as API
  B->>T: GET /api/v1/items (cookie)
  T->>O: forwardAuth /api/auth/auth
  O-->>T: 202 + Authorization: Bearer (audience-restricted token)
  T->>A: GET /v1/items (prefix stripped)
  A->>A: verify signature, iss, aud, exp; find or create the user
  A-->>B: 200 JSON
  Note over B,K: No cookie: 401. The SPA navigates to /api/auth/start, Keycloak signs the user in, /api/auth/callback sets the cookie.
```

Routes (priority order): `/idp` Keycloak, `/api/auth` oauth2-proxy, unsafe `/api/*` without
`X-Requested-With: fetch` is refused (403), `/api/*` session-checked then API, everything else the SPA.

## Pieces and why

- **Gateway**: Traefik with a static file (no Docker socket). One origin means no CORS and a cookie that never goes cross-site.
- **BFF**: oauth2-proxy runs the code flow with PKCE; tokens live in Valkey, the browser holds an opaque cookie.
- **API**: layered (routers, services, repositories) with a shared kernel; it validates tokens itself, so a gateway mistake is not an authorization bypass. Migrations run once in a `migrate` job, not at boot.
- **Database**: one PostgreSQL, two databases and two roles (`app`, `keycloak`) that share nothing.

## Growing it

| Stage | You have | Add |
|---|---|---|
| Small (this) | one API process, one database, one origin, a dev-mode identity provider | a real TLS entrypoint, Keycloak in `start` mode, backups |
| Medium | several features, background work, audit needs | feature modules with explicit interfaces inside the API (or the `system-medium` bundle: Spring Modulith, outbox, worker, audit, object storage, feature flags); a worker process reading an outbox table; Valkey for rate limits shared across replicas; OpenTelemetry to a collector |
| Large | several teams, several deployables, scale | split a module into a service along an event contract; a message broker; a managed IdP; an API gateway with per-client limits; Kubernetes (the compose file is the shape: one image per service, read-only, non-root, probes `/healthz` `/readyz`); contract tests between services |

Rule of thumb: grow when a measured problem asks for it. The module boundaries you keep clean now are the seams you cut later.
