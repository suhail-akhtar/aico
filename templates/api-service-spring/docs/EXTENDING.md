# Extending __APP_TITLE__

## Add a resource (the main move)

Copy `items/` and rename. Example: a `notes` feature.

1. **Copy** `src/main/java/com/example/app/items` to `.../notes` and rename the types
   (`Item` -> `Note`, `ItemService` -> `NoteService`, ...). Fix `package-info.java` (module name).
2. **Migration**: add `src/main/resources/db/migration/V3__create_notes.sql` (V1 and V2 exist; use
   the next free number). Owner column with a foreign key to `accounts(id)`, a `version bigint not
   null` column, an index that matches the list query (`(owner_id, created_at desc, id)` serves the
   cursor paging). Plain SQL that PostgreSQL and H2 both accept. Never edit an applied migration.
3. **Domain**: the record validates itself in its constructor; the repository port takes the
   owner on every lookup, so a missing ownership check cannot be written.
4. **Adapter**: entity (package-private, in `infra`), Spring Data interface (package-private), and
   the adapter implementing the port.
5. **API**: request and response records, controller under `/api/v1/notes`, owner from
   `AuthenticatedUser.id(jwt)`. Add `@Operation` summaries. Lists return a `CursorPage` and take
   `limit` and `cursor` (see `ItemController.list` and `ItemRepositoryAdapter.findByOwner`); JSON
   names are snake_case automatically.
6. **Tests**: copy `ItemTest`, `ItemServiceTest`, `ItemsApiIT`, and the "another user's item is
   404" cases from `SecurityIT`. `OpenApiContractIT` checks the new routes are documented, and
   `ArchitectureTest`/`ModularityTest` check the structure with no edits.
7. Run `make check`. Add a `CHANGELOG.md` line and a backlog tick.

## Add a column

New migration `V<n>__add_<column>.sql`; add the field to the entity, the domain record, the
mapper in the adapter, and the response record; update the tests. `ddl-auto=validate` makes the app
refuse to start if entity and schema disagree, which is what you want.

## Add an endpoint to an existing feature

Service method first (one transaction), then the controller method, then the test. Keep rules in
the domain or service; the controller only parses, calls and shapes.

## Use an external identity provider (OIDC)

Built in: set `APP_AUTH_MODE=oidc` plus `OIDC_ISSUER`, `OIDC_JWKS_URI` and `OIDC_AUDIENCE` (see the
README section "Run behind an OIDC gateway"). Nothing else changes: controllers still read the
owner from `AuthenticatedUser.id(jwt)`, and `identity/` provisions an account row the first time it
sees a `sub`, so `items.owner_id` keeps its foreign key.

The pieces, if you need to change them:

- `shared/security/OidcJwtDecoders` builds the decoder (RS256 pinned, JWKS cache with a rate-limited
  refetch, issuer/audience/`exp`/`sub` checks, fail closed to 401). Another provider usually needs
  only different values. If its `sub` is not a UUID, change the `sub` rule there, store the subject
  as text, and change the owner column type in a new migration.
- `shared/security/CallerProvisioner` is the port the filter chain calls after verification;
  `identity/app/OidcAccountProvisioner` implements it (create on first sight, 409 on an email owned
  by another account, 403 when `is_active` is false). Add a role or tenant claim mapping there.
- `identity/api/LocalAuthGuard` turns `register` and `login` into 404 in this mode; delete the
  local half of `identity` (`AuthService.register/login`, `JwtTokenIssuer`, `BcryptPasswordHasher`)
  if you never go back to local mode.
- Tests: `OidcModeIT` runs the whole app against `support/FakeIdentityProvider` (a JWKS server in
  the test JVM that signs tokens with generated keys). Copy that style rather than mocking the
  decoder; for a one-off controller test `spring-security-test`'s `jwt()` post-processor is enough.

## Call another service

Define a port in the feature's `domain`, implement it in `infra` with `RestClient` built from the
injected `RestClient.Builder` (connect 5 s and read 10 s timeouts are already the defaults in
`application.properties`). Retry only idempotent calls, with a bound; Spring Framework 7's
`@Retryable` and `@ConcurrencyLimit` cover it without another library. Allow-list hosts if the URL
comes from user input (SSRF).

## Turn on telemetry

Set `APP_OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318`. Traces,
metrics and logs go out over OTLP/HTTP; request ids are already in every log line and problem body.
Tune `APP_TRACING_SAMPLE_RATE` (default 0.1).

## Add a background job or event

Start with `@Scheduled` plus an idempotent method. When two features must react to each other, add
Spring Modulith events (`spring-modulith-events-api` and the JPA registry starter) so the publish is
transactional; `ModularityTest` already verifies module boundaries.

## What not to do

- Do not take the owner from the request body or path. Take it from the token.
- Do not return entities from controllers; use response records.
- Do not edit an applied migration; add a new one.
- Do not catch exceptions to return `null`; throw a `DomainException` subclass and let
  `ProblemDetailsAdvice` answer.
- Do not import one feature from another. Share through `shared/` or a published event.
- Do not put JPA or Spring types in `domain/`. `ArchitectureTest` fails the build if you do.
- Do not turn off CSRF-adjacent protections, the rate limiter or the header policy to make a test
  pass; fix the test.
- Do not add `@Autowired` fields; use constructor injection.
- Do not log secrets, tokens, passwords or request bodies.
