# Extending __APP_TITLE__

Read `AICO.md` for the rules; this is the how.

## Add a module (a new feature on the API)

1. Copy `services/api/src/main/java/com/example/system/tasks` to a new package, rename, keep the layers
   `api` (controller + request/response records), `app` (service), `domain` (plain Java + repository
   port + events), `infra` (JPA adapter). Add a `package-info.java` like the others.
2. Add a Flyway migration `V<next>__<name>.sql` under `src/main/resources/db/migration`. Never edit an
   existing one.
3. Scope every query to the owner taken from `AuthenticatedUser.current()`; a foreign id is a 404.
4. Another module needs to know? Publish an event in `domain/event` and listen with
   `@ApplicationModuleListener` there; do not import the other module's classes. Make the consumer
   idempotent with `Inbox.firstDelivery(consumerName, eventId)`.
5. Audit it: the `audit` module records events; add a listener for yours.
6. Tests: a unit test for the domain and service (see `TaskServiceTest`), an integration test on the
   real stack (`TasksApiIT` extends `IntegrationTest`); `./mvnw verify` keeps the architecture and
   modularity tests honest.

## Add a screen

`services/web/src/components`, one file per area; call the API through `src/api.ts` (it adds the
CSRF header and turns problem-details bodies into errors). Add a test beside it using
`src/test/fake-api.ts`.

## Add a role, a user or a client

Edit `infra/keycloak/realm-app.json`. The import runs only when the realm does not exist, so on an
existing stack change it in the admin console, or `docker compose down -v` to start clean. Roles
reach the API as the flat `roles` claim; `identity/security/Roles.java` maps them.

## Add a feature flag

Add it to `infra/flagd/flags.json` and to `shared/flags/FeatureFlags.java`. flagd reloads the file.

## Add a service (container)

Add it to `compose.yaml` with `<<: *hardened`, a pinned image digest, a healthcheck, named volumes only,
and its secrets as `${VAR:?...}` entries in `.env.example`. Route it in `infra/traefik/dynamic.yml`.

## Environment variables

Every value is in `.env.example`; the API's own settings are mapped in `application.properties`
and validated at startup (`AppProperties`, `ConfigurationCheck`). A wrong value stops the container
with a message naming the setting.
