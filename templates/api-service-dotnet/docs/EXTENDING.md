# Extending this service

## Add a feature (the main move)

Copy `src/ApiService/Features/Items/` to `Features/Orders/` and rename. Each file has one job:

1. **`Order.cs`** the entity and its EF mapping. Private setters; `Create`/`Update` enforce the rules;
   limits are constants (`NameMaxLength`) that the DTOs reuse. No ASP.NET types.
2. **`OrderDtos.cs`** request records are `public` with DataAnnotations (`[Required]`, `[StringLength]`,
   `[Range]`). They must be public: the framework's validation generator skips internal types, and a skipped
   validator fails silently. `ArchitectureTests.Only_request_dtos_are_public` pins the list; add yours to it.
   Responses are `internal` records built in a `From(entity)` method (manual mapping, no mapper library).
3. **`OrderService.cs`** the use cases. Start every query from `Owned(ownerId)`; return 404 (not 403) for
   anything the caller does not own. Throw `NotFoundException`/`ConflictException`; never build an error body.
4. **`OrderEndpoints.cs`** `MapGroup("/orders").RequireAuthorization()`, then one `MapX` per verb with
   `.WithName`, `.WithSummary`, `.Produces<...>()`, `.ProducesProblem(...)`. Handlers only translate HTTP.
5. **`OrdersExtensions.cs`** `AddOrdersFeature` registers the service.
6. **Wire it**: `builder.AddOrdersFeature()` and `app.MapOrderEndpoints()` in `Program.cs`; add the `DbSet` to
   `AppDbContext` (and a relationship to `User` there, not in the feature).
7. **Migrate**: `make migration name=AddOrders`. Read the generated file; it is committed and never edited again.
8. **Test**: copy `ItemsTests.cs` (CRUD, ownership, pagination, validation, hostile strings).
9. **Accept the contract change**: `UPDATE_SNAPSHOTS=1 dotnet test --solution ApiService.slnx`, review the diff in
   `Snapshots/openapi.v1.json`, commit it. Then `make check`.

## Add a column

Change the entity (`Update` rules), the DTO, the response `From`, then `make migration name=AddSku`. A new
`NOT NULL` column needs a default or a two-step migration. `The_committed_migrations_match_the_model` fails
until you do.

## Add a role or permission

In local mode put a `role` claim in `TokenService.CreateAccessToken` (in oidc mode map the provider's claim, see above), then `RequireAuthorization(p => p.RequireRole("admin"))`
on the group. Roles are read when a token is issued, so a role change takes effect at the next refresh.

## Move authentication to an identity provider

Already built in: set `AUTH_MODE=oidc` with `OIDC_ISSUER`, `OIDC_JWKS_URI` and `OIDC_AUDIENCE` (README, "Run behind an OIDC
gateway"). One bearer scheme is configured per mode in `Features/Auth/JwtBearerSetup.cs`: local is HS256 with this service's key,
oidc is RS256 with keys from the JWKS URL (`JwksKeyManager`), and `OidcUserProvisioner` creates the user row for a new `sub` in
OnTokenValidated. `Items` only reads the `sub` claim (`GetUserId`), so it does not know which mode is active.
To drop local authentication entirely, delete `TokenService`, `AuthService`, `Argon2idPasswordHasher`, the credential endpoints
and their tests, and keep `/auth/me`. Roles and groups from the provider are not mapped: read them from the validated principal
in `OnTokenValidated` (add a claim or a policy), never from the request body.

## Change the wire format

Property names are snake_case by one policy (`PropertyNamingPolicy` in `PlatformExtensions.AddPlatform`); do not add `[JsonPropertyName]`
to a DTO, and do not rename a member without re-accepting the OpenAPI snapshot: the front end depends on these names.

## Call another service

Not included (no dependency without a use). Add `Microsoft.Extensions.Http.Resilience` and register a typed client:
`services.AddHttpClient<PaymentsClient>().AddStandardResilienceHandler();` (timeouts, retries with jitter, circuit
breaker). Put the client behind an interface in the feature that needs it so tests substitute it.

## Background work

Small and idempotent: a `BackgroundService` reading a `Channel<T>`. Two replicas both run it, so make it safe to run
twice. Anything that must happen exactly once belongs in a queue or a scheduler, not in the web process.

## Logging, metrics, traces

Use `ILogger<T>` with source-generated `[LoggerMessage]` methods (the analyzers require it). Every line already
carries `CorrelationId`, `RequestId` and `TraceId`. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to export; add
`.AddSource("MyApp")` in `Platform/Telemetry.cs` for your own `ActivitySource`.

## What not to do

- No query without `Owned(...)`; no `[FromBody]` entity (bind a request DTO, never an entity).
- No `catch (Exception)` to "keep going"; let the exception handler answer.
- No secrets in code, `appsettings*.json`, the image or tests (test canaries are obviously fake and carry
  `standards-allow: secret`).
- No editing a committed migration, and no `EnsureCreated` outside the development SQLite path.
- No suppressing an analyzer to get green: fix it, or justify the rule in `.editorconfig` with a reason.
- No reference between feature folders; if two features need to talk, introduce an interface in `SharedKernel`
  or an event (see `docs/ARCHITECTURE.md`).
