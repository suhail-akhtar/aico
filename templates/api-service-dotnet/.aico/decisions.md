# Decisions — __APP_TITLE__

One entry per decision: what, why, and what was rejected. Append; do not edit old entries. Versions are the ones
resolved in the committed `packages.lock.json` files and verified on 2026-10-06 (`make check` green, suite also green on
PostgreSQL 18.6). Every package below is used; a package that stops being used leaves the manifest in the same change.

## Platform and structure

- **.NET 10 (LTS, supported to 2028-11-14)** on ASP.NET Core 10. `global.json` pins SDK `10.0.100` with
  `rollForward: latestFeature` (built and tested here with SDK 10.0.102 locally and 10.0.401 in the image). .NET 9 and 8
  both end 2026-11-10; .NET 11 is an RC and not used. Runtime image `aspnet:10.0.12-noble-chiseled`.
- **Minimal APIs with endpoint groups and `TypedResults`, not controllers.** Per-endpoint metadata feeds the
  generated OpenAPI document directly, handlers are plain static methods, and there is no controller base class to
  hide behaviour in. Controllers stay a valid choice for a team that prefers them; nothing here depends on the style.
- **One project with feature folders, not Api/Application/Domain/Infrastructure projects.** At this scale four
  projects add references and ceremony without adding a boundary the compiler would not already be told about. The
  boundaries are written as rules and tested (`ArchitectureTests`, NetArchTest 1.3.2), which is what makes the later
  split a move of files (`docs/ARCHITECTURE.md`, stages 2 and 3).
- **No mediator, no mapper, no generic repository.** MediatR 14 and AutoMapper 16 carry reciprocal/commercial licences;
  plain services and hand-written `From(entity)` mapping are shorter and show the data flow. `AppDbContext` is already a
  repository and unit of work.
- **Config from the environment, validated at startup** (`ValidateOnStart` plus `IStartupValidator` before the
  database is touched). Placeholder secrets and the SQLite provider are refused outside Development and Testing.
  `appsettings*.json` hold only non-secret defaults.

## Data

- **EF Core 10.0.12 + Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3; PostgreSQL 18.6 in compose and in the container
  tests.** Migrations are generated for Postgres and applied by `ApiService --migrate` (a one-shot job in compose and
  the recommended production step), not at application start (`Database__MigrateOnStartup` exists for compose and
  development only).
- **SQLite for Development and the default test run** (Microsoft.EntityFrameworkCore.Sqlite 10.0.12), schema from
  `EnsureCreated`, refused in production. Reason: a fresh clone runs with no database server, which is also what lets
  AICO preview it. Cost: development does not exercise migrations. Mitigations: entities use only portable types
  (Guid, string, int, DateTimeOffset, no ordering or comparing on DateTimeOffset), the *whole* suite runs on real
  PostgreSQL in CI and via `make test-pg`, and `The_committed_migrations_match_the_model` fails if a model change has no
  migration.
- **UUIDv7 ids (`Guid.CreateVersion7`) and keyset pagination** (`?limit=&cursor=`, answer `next_cursor`): time-ordered, index-friendly, stable
  while rows are added, no `COUNT`. Offset pagination was rejected for its cost and instability.
- **Ownership by construction:** every query starts from `Owned(ownerId)`; another user's row is a 404, never a 403,
  so ids cannot be probed.

## Authentication and security

- **JWT bearer (HS256) access tokens, 15 minutes, plus opaque refresh tokens with rotation, family revocation on reuse,
  hashed at rest (SHA-256).** Chosen over cookie sessions because the consumers of an API service are mobile apps,
  SPAs and other services, where cookies add CSRF handling for no benefit. `JsonWebTokenHandler` and JwtBearer come with
  ASP.NET Core (Microsoft.IdentityModel 8.19.2): no extra token library. Validation requires signature, issuer, audience
  and lifetime, accepts only HS256 (no algorithm confusion, no `none`), 30 s skew, and judges time with the injected
  clock. HS256 is right while this service is the only verifier; the move to an identity provider is documented.
- **Passwords: Argon2id via Konscious.Security.Cryptography.Argon2 1.3.1 (MIT), m = 64 MiB, t = 3, p = 1, 16-byte salt,
  32-byte hash, PHC string format.** Source: OWASP Password Storage Cheat Sheet, which makes Argon2id the first choice
  with a minimum of 19 MiB, 2 iterations, 1 lane; ours is above the minimum and matches RFC 9106's second profile with
  p = 1. The parameters are code (`PasswordHashingOptions`), pinned by `PasswordHasherTests`, carried inside every hash,
  and a weaker stored hash is upgraded on the next login. **Rejected: ASP.NET Core Identity's `PasswordHasher`**, whose
  default is PBKDF2-HMAC-SHA512 at 100,000 iterations, below OWASP's 220,000 for that function (the fallback figure if
  Argon2 were unavailable or FIPS were required), and which drags in a user-store model this service does not use.
  Risk noted: Konscious is pure managed code and its last release is 2024-06; if that matters, swap the hasher
  behind `IPasswordHasher` for PBKDF2-HMAC-SHA512 at 220,000 or more with an identical test.
- **Login does the same work for an unknown account** (no timing oracle), answers one message for both failures, and
  sits behind the strict `auth` rate limit. Known limit: no per-account lockout, no email verification, no password
  reset, no MFA: those are product decisions listed in the backlog for the user.
- **Built-in rate limiting** (fixed window per client address; stricter for `/auth`; probes exempt). In memory, so
  per instance: with several replicas put a gateway or a distributed limiter in front. Behind a proxy enable
  `ForwardedHeaders` with the proxy's CIDR; trusting every sender is refused at startup.
- **Security headers, CORS and body limits written as small middleware, no package.** Strict CSP (`default-src
  'none'`), no sniffing/framing/referrer, `no-store`, no `Server` header, HSTS outside Development. CORS is an exact
  allow-list, no credentials, empty by default. Body size is enforced twice: Kestrel (real server, including chunked)
  and a guard that answers a declared oversize with a 413 problem (also under the in-memory test server).
- **One exception handler (`IExceptionHandler`) and `AddProblemDetails`: RFC 9457** for every error, with `code`,
  `request_id`, `trace_id`; validation keys are snake_case; unexpected exceptions get a fixed message. Rejected:
  per-endpoint try/catch.
- **Validation: the framework's built-in `AddValidation()` (DataAnnotations, source generated), not FluentValidation.**
  No dependency, native problem-details output. Finding recorded here because it costs a day to find: the generator
  only sees `public` types, so request DTOs are public (and `ArchitectureTests` pins that list); an internal DTO
  silently skips validation. Unknown JSON members are rejected (`UnmappedMemberHandling.Disallow`): no mass assignment.
  FluentValidation becomes worth it for cross-field rules at medium scale.

## Contract v1 and OIDC resource-server mode (template 1.1.0)

Why: this API can now sit behind a gateway with an identity provider, serving a front end shared with the other API
starters, so the wire format had to be one contract and authentication had to be pluggable. No new NuGet package:
`Microsoft.IdentityModel.*` comes with JwtBearer, `IHttpClientFactory` is in the shared framework, and the lock files did not change.

- **snake_case JSON everywhere, one `PropertyNamingPolicy`, no per-DTO attributes; `after` became `cursor`, `nextCursor`
  became `next_cursor`, the default page is 50 (max 100).** The paths keep no prefix (the gateway maps `/api/v1`). A camelCase
  request member is rejected like any unknown member (no silent dual spelling). **Breaking** for existing clients; recorded in
  the changelog. The cursor stays the last item id (UUIDv7) but clients must treat it as opaque. Alternative rejected: keeping
  camelCase and translating in the gateway (every client would need the same shim).
- **`AUTH_MODE=local|oidc` (`Auth__Mode`), default local, so a standalone starter is unchanged.** One bearer scheme whose
  options are built for the active mode in `JwtBearerSetup`; never both at once. Rejected: two schemes tried in turn (a token
  valid for the other mode could be replayed), a policy scheme that guesses from the token (the guess is the attack surface).
  An unknown mode value stops startup: a typo must not fall back to local authentication.
- **A resource server, not a login flow.** The gateway (oauth2-proxy) owns the browser session and forwards a bearer token; this
  service only validates it. It still validates everything itself, because a proxy's say-so is not authentication.
- **Keys from `OIDC_JWKS_URI`, no discovery document.** The issuer a token carries is the public URL; the keys live on an
  internal one, which discovery would derive wrongly. A small `JwksKeyManager` (not IdentityModel's `ConfigurationManager`)
  caches the keys for an hour, refetches BEFORE validating a token whose `kid` is unknown (so the first token after a rotation
  works; the library's own refresh only helps the next request and would make that first one a 401), at most once per
  `Oidc__JwksRefreshIntervalSeconds` (30), with a 5 s timeout, a 256 KiB cap and no redirects, and keeps serving the last good keys if
  the provider is down. With nothing cached it answers an empty key set (a 401), never an exception: JwtBearer does not
  catch one from a custom manager and the answer was a 500, found by a test. It uses the injected clock, so rotation, flood and
  outage behaviour are tested without sleeping.
- **RS256 pinned; the token's `kid` must name a published key (`TryAllIssuerSigningKeys=false`).** Only RSA signing keys of at
  least 2048 bits with `use` sig (or absent) and `alg` RS256 (or absent) are accepted from the document. Issuer compared as an
  exact string, audience must contain `OIDC_AUDIENCE`, `exp` required, 30 s leeway on the injected clock, `sub` must be a canonical UUID.
- **Just-in-time provisioning in OnTokenValidated (`OidcUserProvisioner`).** User id = `sub`; email = the `email` claim
  lower-cased, or `<sub>@oidc.invalid` (reserved TLD, can never receive mail; also used if the claim is over 254 characters);
  password hash = `!oidc-account-has-no-local-password`, which is not a PHC string, so the hasher says "failed" and local
  login is the ordinary 401 (and does the same work as for an unknown account: no timing hint). Race-safe: the primary key decides,
  the loser re-reads, and a few short retries cover a transient database refusal. Nothing is synchronised later: the provider
  owns the identity; this row only anchors owner ids. One primary-key read per authenticated request; a cache is the first step if that shows in a profile.
- **Email collision: 409 `identity_conflict`, never a merge.** If a row with another id already owns the email (a local
  registration, or a different subject), linking them automatically would let anyone who can set an email claim at the provider
  take over a local account. Cost: that person must be linked by an operator. Authentication cannot answer 409 (JwtBearer turns every
  failure into a 401), so the conflict travels as the authenticate failure and is rethrown from OnChallenge for the shared exception handler.
- **Local credential endpoints answer 404 `local_auth_disabled` in oidc mode** from a middleware keyed on endpoint metadata, not an
  endpoint filter (filters run after model binding, so a malformed body would answer 400 first). They stay mapped in both modes, so the
  OpenAPI document is byte-identical (a test asserts it). The dev seed user is not created, and `Jwt:SigningKey` is not required in oidc
  mode (its rules moved from annotations into `JwtOptionsSafety` for that reason).
- **No `is_active` column exists in this starter, so there is no "disabled account" state to refuse.** Deactivating a person is the
  provider's job (it stops issuing tokens); add a column and a check in `OidcUserProvisioner` if the product needs local suspension.
- **The provider is trusted for the email claim** (`email_verified` is not checked): the collision rule above is what stops an unverified
  address from taking over an existing account. Tighten it if your provider allows unverified emails.
- **Not done:** group or role mapping, token introspection or revocation lists (tokens live until `exp`, minutes), mutual TLS to the
  JWKS endpoint, and a distributed key cache (each replica fetches its own keys).

## Operations

- **Built-in JSON console logging, no Serilog.** One JSON object per line with scopes (correlation id, request id, trace
  id); source-generated `[LoggerMessage]` methods (analyzer-enforced). Serilog would add a dependency for nothing here.
- **OpenTelemetry 1.19.x (Extensions.Hosting, OTLP exporter, ASP.NET Core and HttpClient instrumentation), registered
  only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.** Probes are excluded from traces. EF Core instrumentation is still
  prerelease and not used; the Npgsql `ActivitySource` is added instead.
- **Health:** `/healthz` (liveness, checks nothing) and `/readyz` (database answers, and unhealthy as soon as shutdown
  starts so a balancer drains the instance). Bodies are a status word only. Graceful shutdown: 25 s `ShutdownTimeout`,
  exec-form entrypoint so SIGTERM reaches the process (measured: `docker stop` exits 0 in under a second when idle).
- **OpenAPI: built-in `Microsoft.AspNetCore.OpenApi` 10.0.12 (3.1.x) + Scalar.AspNetCore 2.17.13, Development only.**
  The document is a committed snapshot compared by a test, so the API surface is reviewed like code. Swashbuckle
  rejected (not needed). Scalar serves its UI from the package (no CDN), and is the one place the strict CSP relaxes.
- **Image: `sdk:10.0.401-noble` build, `aspnet:10.0.12-noble-chiseled` runtime** (no shell, no package manager, non-root
  uid 1654, 78 MB), `HEALTHCHECK` is the app itself (`ApiService --healthcheck`) because the image has no curl.
  `restore --locked-mode` and NuGet Audit run inside the build. Compose runs migrate-then-serve, read-only root
  filesystem, all capabilities dropped. `GSS Encryption Mode=Disable` in the connection string stops Npgsql probing for
  Kerberos libraries the chiseled image lacks. Tags are exact patch versions; Dependabot proposes bumps.
- **SBOM:** CycloneDX 6.2.0 (local tool) of what ships (`make sbom`), uploaded by CI.

## Supply chain, quality, tests

- **Central Package Management + `packages.lock.json` per project + `nuget.config` with one mapped source.** CI restores
  in locked mode; the Docker build uses `--locked-mode`. NuGet Audit (`NuGetAuditMode=all`, level `high`) fails restore
  on a high or critical advisory, transitive included; `make audit` forces a re-audit and lists deprecated packages.
  Reviewed exceptions only through `audit-allowlist.props`. Verified on 2026-10-06: no vulnerable, no deprecated, no
  outdated package. All licences are permissive (MIT, Apache-2.0, PostgreSQL licence).
- **Analyzers: `AnalysisLevel=latest-all` (the SDK's .NET analyzers, every rule on) + Meziantou.Analyzer 3.0.294 (MIT),
  `TreatWarningsAsErrors`, `EnforceCodeStyleInBuild`, `dotnet format --verify-no-changes`.** The rules switched off in
  `.editorconfig` each carry a reason (no ConfigureAwait in ASP.NET Core, several small types per file, ...).
  Roslynator and StyleCop were not added: the above already fails the build on style and quality findings.
- **xunit.v3 4.0.1 on Microsoft.Testing.Platform.** xunit.v3 4.x tests cannot run through the old VSTest target on the
  .NET 10 SDK, so `global.json` selects the MTP runner for `dotnet test`. Assertions are xunit's own `Assert`: no
  assertion library (FluentAssertions 8 is commercial, and the built-in set is enough).
- **Coverage: coverlet.MTP 10.1.0 (MIT) with a hard gate, 85 % of lines, migrations excluded; ReportGenerator 5.5.11 for
  the report.** Microsoft's own coverage extension is proprietary-licensed and was not chosen. Measured 95.3 % lines on
  2026-10-06 (212 tests: 211 on SQLite plus the opt-in PostgreSQL test; all 212 pass against PostgreSQL 18.6). The `Postgres_*` test and the container run need Docker and are opt-in (`TEST_POSTGRES=1`).
- **Testcontainers.PostgreSql 4.15.0** (MIT) for the opt-in PostgreSQL run: one container per run, one database per
  test host. **Microsoft.AspNetCore.Mvc.Testing 10.0.12** hosts the app in memory. **Microsoft.Extensions.TimeProvider.Testing
  10.10.0** is the fake clock (token and refresh expiry are tested by moving time, not by sleeping).
- **Verify (snapshot library) was tried and rejected:** version 33 refuses to build without a sponsorship or licence
  property (SponsorCheck SC021), which a starter must not impose on its users. The OpenAPI snapshot is 30 lines of test code.
- **Not included, on purpose:** Microsoft.Extensions.Http.Resilience (no outbound calls exist yet; the recipe is in
  `docs/EXTENDING.md`), Polly, Mapperly, FluentValidation, Serilog, Swashbuckle, MediatR, AutoMapper, MassTransit,
  Hangfire, Moq, Shouldly, NSubstitute (no mocks are needed: the tests use the real stack).

## Honest limits

HS256 shared secret; per-instance rate limiter; no account lockout, email verification, password reset or MFA; no
optimistic concurrency (`If-Match`) or idempotency keys on writes; development runs on SQLite while production runs on
PostgreSQL (mitigated as described above); the first migration on an empty database logs EF's probe for its history
table unless that category is silenced (compose does).
