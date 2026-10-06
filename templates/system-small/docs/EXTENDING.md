# Extending

## Add a resource across the stack

1. **API** (`services/api`): follow `services/api/docs/EXTENDING.md` (model, migration, repository, service, router, tests); `make openapi` regenerates `openapi.json`.
2. **Contract**: copy the resource's paths and schemas into `services/web/openapi/openapi.json` (keep `operationId`s), then `npm run gen` in `services/web`.
3. **Web** (`services/web`): follow `services/web/docs/EXTENDING.md` (mock, feature, route, strings, tests). The mock gateway keeps `npm run dev` working without the stack.
4. **E2E**: add the flow to `services/web/e2e/`; run `docker compose --profile e2e run --rm e2e`.
5. Tick the story in `.aico/backlog.md`; add a CHANGELOG line.

## Change the identity provider

oauth2-proxy speaks any OIDC provider: change `OAUTH2_PROXY_*` URLs, client id and secret in `compose.yaml`,
remove `keycloak` and the `10-keycloak.sh` init, and set `OIDC_ISSUER`, `OIDC_JWKS_URI`, `OIDC_AUDIENCE` on the API.
The API requires the token's `aud` to contain `OIDC_AUDIENCE`; make your provider issue it (Keycloak: the audience mapper in `realm.json`).

## Run without the stack

`services/web`: `npm run dev` (mock gateway, sign in as dev@example.com). `services/api`: `AUTH_MODE=local` (the default)
gives register/login with Argon2id and short-lived JWTs; point a client at it directly.

## Do not

- Put a secret in a tracked file, or publish a service port other than the gateway's.
- Loosen Traefik's CSRF rule or the API's token checks to make a client work.
- Mount the Docker socket into Traefik (use file configuration).
