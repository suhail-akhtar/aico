# Decisions — __APP_TITLE__

One entry per decision: what, why, what was rejected. Append; do not edit old entries. Compaction
keeps this file when it drops the transcript. Versions below are what Maven resolved when the
starter was verified (2026-10-06); `./mvnw dependency:tree` is the source of truth afterwards.

## Platform and versions

- **Spring Boot 4.1.1** (not 3.5.x, not 4.0.x). 3.5's open-source support ended 2026-06-30; 4.0
  ends 2026-12-31; 4.1 (GA 2026-06-30) is supported to 2027-07-31 (api.spring.io). 4.2 is still
  milestones. Resolved: Spring Framework 7.0.9, Spring Security 7.1.1, Spring Data JPA 4.1.1,
  Hibernate ORM 7.4.5, Hibernate Validator 9.1.3, Jackson 3.1.7 (`tools.jackson`), Tomcat 11.0.26,
  Micrometer 1.17.1, OpenTelemetry API 1.62.0, HikariCP 7.0.2, Logback 1.5.38.
- **Java 25 (LTS)**, Temurin. Boot 4.1 supports 17-26; 25 is the newest LTS. The code is plain
  Java 21+ and compiles on 21 too (`-Djava.version=21`), which is how the build was iterated on a
  machine with only JDK 21; the final verification ran on 25.0.4.1 (Docker image).
- **Maven 3.9.16 through the wrapper**, not Gradle (Maven's lifecycle makes "verify = everything"
  one command; the wrapper pins the tool). Maven 4 is still a release candidate. The wrapper
  uses `distributionType=only-script`; no `distributionSha256Sum` because the script downloads
  the `.zip` on Windows and the `.tar.gz` elsewhere, so one checksum cannot match both. It
  downloads over HTTPS from Maven Central.
- **PostgreSQL 18** (`postgres:18-alpine`, 18.6) in compose and tests, pinned by digest in compose.
- **Version overrides of the Boot BOM**, each a patch/minor bump justified by the audit (see the
  comment in `pom.xml`): Tomcat 11.0.24 -> 11.0.26 and Jackson 3.1.5 -> 3.1.7 / 2.21.5 -> 2.21.7
  (three critical Tomcat and several high Jackson advisories found by `make audit` the day the
  starter was built); Flyway 12.4.0 -> 13.9.0 (current GA, passes the full suite on PostgreSQL 18).
  Remove an override when Spring Boot's BOM catches up.
- **google-java-format 1.36.0, not 1.37.0.** 1.37.0 is on Maven Central but fails inside Spotless
  3.10.3 (`InvocationTargetException`, every file); 1.33-1.36 work. Retry on the next Spotless bump.

## Structure

- **Package by feature with a shared kernel** (Spring Boot's own structuring guidance), hexagonal
  only at the edges that pay off: persistence and the token issuer/hasher are ports with adapters;
  the domain is plain Java. Rejected: layer packages (`controller/`, `service/`, `repository/`) which
  scatter a feature; a repository wrapper over Spring Data inside the adapter beyond the port; a
  separate Maven module per layer (compile-time isolation is a large-scale need).
- **Spring Modulith 2.1.1 for verification only** (`spring-modulith-api` + `-starter-test`): module
  cycles and encapsulation are checked in `ModularityTest`, and it generates the diagram. Events and
  the persistent registry (outbox) are documented growth steps, not in the base.
- **ArchUnit 1.5.1** for the rules Modulith does not express (layer direction, framework-free
  domain, JPA confined to `infra`).
- **Records and hand-written mapping**, no MapStruct: three tiny mappers do not justify an
  annotation processor. No Lombok (records plus Boot make it unnecessary; NullAway dislikes it).
- **Entities are package-private** and hold a plain `owner_id`, not a JPA association, so a feature
  never reaches another feature's tables. The foreign key lives in SQL.
- **UUID ids generated in the application**, offset pagination (page, size, capped at 100) because
  the base lists are small; keyset pagination and an `Idempotency-Key` are growth steps.
- **Optimistic locking** (`@Version`, optional `version` in PUT, 409 on conflict) so concurrent
  edits are reported, not lost.

## Security

- **Resource server with a local HS256 issuer.** One service both issues and verifies, so a shared
  secret (32+ characters, validated at startup, placeholder rejected) is enough. Issuer, audience and
  expiry are checked. Rejected: RSA/EC keys now (key management with no second verifier); sessions.
  Documented path to an external OIDC provider in `docs/EXTENDING.md`.
- **bcrypt cost 12** (OWASP floor 10, 72-byte limit enforced by policy, rehash on login). Argon2id
  is OWASP's first choice but Spring's encoder needs BouncyCastle: a new dependency for no gain at
  this scale. Switching is one class (`BcryptPasswordHasher`) plus a `DelegatingPasswordEncoder`.
- **CSRF off**, documented: bearer tokens, no cookies, no sessions.
- **No Spring Security default user, no form login, no HTTP basic.** Only the JWT filter.
- **Own small rate limiter** (token bucket per address, stricter on login/register) rather than
  Bucket4j: ~60 lines, no dependency, correct for one process; scale-out needs a shared store or
  the gateway (documented). Own body-size filter because Tomcat limits only form posts.
- **Actuator exposes only `health`, mapped to `/healthz` (liveness) and `/readyz` (readiness with
  database).** Details hidden. Other endpoints are not exposed.
- **OpenAPI document public, explorer off in the prod profile** unless `APP_DOCS_ENABLED=true`.
- **A startup configuration check** (`ConfigurationCheck`, a bean factory post-processor) validates
  the `AppProperties` rules before any bean exists and reports "DATABASE_URL is not set" or "APP_JWT_SECRET
  must be at least 32 characters", never the value. Found by running the jar: a missing URL used to fail
  with "'url' must start with jdbc", a weak secret was only noticed after Flyway had connected, and Spring
  Boot's own binding report would have printed the secret into the log.
- **Control characters rejected in item text**: found by a hostile-input test (NUL made PostgreSQL
  throw, answering 409); now a 400 with the field named.

## Persistence

- **Flyway, plain SQL, forward-only**, portable between PostgreSQL and H2. `ddl-auto=validate`
  makes startup fail if entities and schema drift. Liquibase rejected (licence change in v5).
- **Tests: PostgreSQL by Testcontainers when Docker is available, H2 (PostgreSQL mode) otherwise**,
  chosen by `TestDatabase`; `AICO_TEST_DB=postgres` makes the fallback an error (CI sets it). H2 is
  test-scope only and never ships. H2 is a weaker proof; the starter says so.
- **`spring-boot:test-run` as the dev runner** (`DevApplication` in `src/test/java`): real app,
  throwaway database, demo user, none of it in the production jar.

## Observability and operations

- **Boot structured logging (ECS JSON) in the prod profile**, plain text in dev; request id in
  every line (MDC) and every problem body; one completion line per request without the path.
- **OpenTelemetry through `spring-boot-starter-opentelemetry`, exporters off unless
  `APP_OTEL_ENABLED=true`** (the starter's defaults would dial localhost:4318 forever).
- **Virtual threads on**, graceful shutdown (20 s), HikariCP 10 connections, connect/read timeouts
  on any `RestClient`.

## Quality gates

- **Spotless (google-java-format)**, **Error Prone 2.50.0 + NullAway 0.14.2** on production code at
  ERROR level, **SpotBugs 4.10.4 + FindSecBugs 1.14.0**, **maven-enforcer** (Java/Maven versions,
  dependency convergence, banned log4j 1 and Lombok). One reviewed SpotBugs exclusion, with its
  reason, in `spotbugs-exclude.xml`. Checkstyle not added: Spotless, Error Prone and SpotBugs
  cover the same ground without a fourth rule set.
- **JaCoCo gate 85% lines** on application code (the `Application` main class excluded), merged
  across unit and integration tests; 96% measured when the starter was verified. Rejected: 100% targets; mutation testing as a PR gate.
- **Audit: OSV-Scanner 2.6.0 (container) on the CycloneDX SBOM**, because OWASP Dependency-Check
  needs an NVD API key to be usable. `osv-scanner.toml` is the reviewed allow-list. The SBOM comes
  from `cyclonedx-maven-plugin` 2.9.3 (Boot parent configuration).
- **JUnit 6.0.3, AssertJ 3.27.7, Mockito 5.23.0** (as managed by Boot), `MockMvcTester` for HTTP
  tests (no RestAssured: it would be a second HTTP test style for nothing).

## Container and CI

- **Layered jar** extracted with `-Djarmode=tools extract --layers --launcher` (the old `layertools`
  mode no longer exists in Boot 4.1), **eclipse-temurin:25-jre-alpine** runtime (BusyBox `wget` for
  the healthcheck, no curl), uid 10001, read-only root in compose, `cap_drop: ALL`. Base images pinned by
  tag and digest. Jib rejected: the Dockerfile is the common denominator across the starters.
- **GitHub Actions pinned by commit SHA** with the tag in a comment; Dependabot updates both. The
  image smoke test is a Node script (`scripts/smoke.mjs`) so it runs the same on Windows, macOS,
  Linux and CI; `scripts/audit.mjs` likewise.
- **Makefile** has the shared verbs; every target is a one-liner over `./mvnw` or docker, and the
  scripts above cover machines without `make`.

## Not done (growth steps, on purpose)

Refresh tokens, password reset, email verification, MFA, a shared rate limiter, keyset pagination,
idempotency keys, an outbox, a broker, CQRS, a service mesh. See `docs/ARCHITECTURE.md`.

## Template 1.1.0: ready to sit behind an OIDC gateway (wire contract v1 + resource-server mode)

Why: the full-stack bundles put one React SPA, with one generated typed client, in front of whichever
API starter is picked, behind a single-origin proxy (Traefik), an OIDC provider (Keycloak) and a BFF
(oauth2-proxy) so the browser never holds a token. The API therefore has to be a plain OIDC resource
server, and all four API starters have to agree on the wire contract. Standalone use is unchanged:
`APP_AUTH_MODE` defaults to `local`. No new dependency was added (Nimbus JOSE is already on the
classpath through `spring-security-oauth2-jose`, 10.9.1 resolved; the test JWKS server is the JDK's
`HttpServer`; Awaitility comes with the Boot test starter).

**Wire contract**
- **snake_case JSON everywhere** through one switch, `spring.jackson.property-naming-strategy=
  SNAKE_CASE`, so records stay idiomatic Java and no field can drift. Rejected: `@JsonProperty` per
  field (drifts), `@JsonNaming` per record (forgotten on the next one). The problem body's
  `requestId` became `request_id` (it is a map key, which the strategy does not rename).
  `accept-float-as-int=false` so `"quantity": 1.5` is a 400, not a silent 1.
- **Keyset pagination replaces offset** (supersedes "offset pagination" under Structure).
  `GET /items?limit=1..100 (default 50)&cursor=` returns `{items, next_cursor}`; order is
  `created_at desc, id asc`, exactly the existing `(owner_id, created_at desc, id)` index, so a page
  is an index range scan and deep pages cost the same as page 1; an insert or delete between pages
  cannot repeat or skip a row. The cursor is `base64url("<created_at micros>_<id>")`, opaque to
  clients, unsigned on purpose: it only names a position inside the caller's own rows (every query
  is owner-scoped), so forging one cannot reveal anything, and OIDC mode has no secret to sign with.
  A bad cursor is a 400 naming `cursor`. The repository fetches `limit + 1` rows; the extra row only
  says "there is more". There is no total count (the cost keyset paging exists to avoid).
  Rejected: encoding a page number in the cursor (offset paging in disguise, with its shifting
  rows); Spring Data `ScrollPosition`/`Window` (would put Spring Data types in the domain port; the
  cursor lives in `shared.page`, which the framework-free domain may use); four derived-query
  variants (name filter x cursor) were replaced by one composed `Specification`, because both
  the name filter and the keyset predicate are optional.
- **`quantity`**: new Flyway `V2` (V1 untouched), `integer not null default 0` plus a check
  `0..1,000,000`; the domain validates the same range; PUT is a full replace, so an omitted quantity
  becomes 0. `version` stays optional on PUT. The description limit stays 2000 (a superset of the
  contract's 1000).

**OIDC resource-server mode** (`APP_AUTH_MODE=oidc`, with `OIDC_ISSUER`, `OIDC_JWKS_URI`,
`OIDC_AUDIENCE` required and named in the startup error; `APP_JWT_SECRET` not needed)
- **Everything is verified in this process**, never on the proxy's word: RS256 pinned (the key
  selector has no other algorithm, which rejects `none`, HS256-with-the-public-key and RS384/PS256),
  `iss` equal to the setting, `aud` contains the audience, `exp` required (Spring's timestamp
  validator ignores a missing one, so a separate rule), `nbf` honoured, skew 30 s by default and at
  most 60 s, `sub` must be a UUID. The 16 KB header cap in `application.properties` still applies.
- **JWKS through Nimbus `JWKSourceBuilder`**, not `withIssuerLocation`/`issuer-uri`: discovery derives
  the key URL from the issuer, but behind a proxy the issuer is the browser-facing URL and the keys
  are reached on an internal one, and Spring's default source has no rate limit on unknown key ids.
  Cache 5 minutes; an unknown `kid` refetches, rate limited to once per `OIDC_JWKS_MIN_REFRESH`
  (30 s), so a flood of invented kids cannot hammer the provider; fetch timeouts 2 s connect and 3 s
  read, 128 KiB size cap.
- **Fail closed to 401** (`FailClosedJwtDecoder`): Spring Security reports "bad token" as a
  `BadJwtException` (401) but "could not look the key up" (provider down, refetch rate limited) as a
  plain `JwtException`, which its filter rethrows as a 500. Both are now the same invalid-token 401,
  with the cause logged for the operator only. Cost: a provider outage looks like a logged-out user
  to the SPA instead of a 503; the spec asked for never-500, and the WARN line says what happened.
- **Just-in-time provisioning** in `CallerProvisioningFilter`, right after the bearer filter, calling
  the `CallerProvisioner` port that `shared/security` declares and `identity` implements (so the
  kernel still knows no feature). A filter, not a token converter: failures in a converter bypass
  `ProblemDetailsAdvice`. Account id = `sub`; email = `email` claim lower-cased, else
  `<sub>@oidc.invalid` (also when the claim is not email-shaped); password hash = the sentinel
  `!no-local-password`, which no hasher output can equal and which `Account.canLogInLocally()`
  refuses before a hasher is asked (a local login with it is the normal 401). Race safety without
  locks: two first requests both insert, the primary key lets one win, the loser re-reads. The
  provisioner is deliberately not `@Transactional`: a failed insert aborts a PostgreSQL transaction,
  so the re-read must be a new one. Cost: one primary-key read per authenticated request (cache for a
  few seconds if it ever shows in a profile). The email is stored at first sight and not synced.
- **Email collision: 409 `identity-conflict`, never a merge.** If a different account already owns
  the address (a local registration from before the switch, or another subject), merging on an email
  claim would let anyone who can set an email at the provider take over that account's data.
  Rejected: merge when `email_verified` is true (trusting the provider's verification is a policy
  the owner should choose, not a default); overwrite; a second table of identities (a schema change
  the contract asked us not to make).
- **`accounts.is_active`** (in `V2`, default true): the Spring starter had no way to disable an
  account, and the contract requires "inactive refused", so the column was added rather than faked.
  Honoured at local login (the normal 401, no signal) and on every request in oidc mode, where it
  answers **403 `account_disabled`**: 401 would send a single-page app into an endless sign-in loop
  for a person who is signed in correctly.
- **Local endpoints in oidc mode**: `register` and `login` answer 404 ("Local authentication is
  disabled: APP_AUTH_MODE=oidc") from a `HandlerInterceptor`, so the answer precedes body validation;
  `JwtTokenIssuer` is not even built (no secret exists) and a `DisabledTokenIssuer` refuses to mint,
  as a second lock. This starter has no refresh or logout endpoints, so there is nothing to disable
  for those. The dev seed (`DevApplication`, test sources) is skipped in oidc mode.
- **Config**: `AppProperties` now carries `auth` (mode, oidc settings) and the secret is nullable;
  cross-field rules ("secret required in local mode", "issuer required in oidc mode") are
  `@AssertTrue` on the records, and `ConfigurationCheck` names the variable per mode. A message that
  already starts with a variable name is printed alone.
- **Rate limits behind a gateway**: the limiter keys on the socket address, which behind a proxy is
  the proxy, so all users would share one bucket. Documented: set
  `SERVER_FORWARD_HEADERS_STRATEGY=native` (Tomcat then trusts `X-Forwarded-For` from private
  networks only) or raise the limits. Not made the default: trusting forwarded headers without a
  proxy lets a client choose its own bucket.
- **compose.yaml** no longer requires `APP_JWT_SECRET` at compose time (it is unused in oidc mode);
  the app still refuses to start without it in local mode and names it.
- **Tests**: `FakeIdentityProvider` (a JWKS endpoint on a loopback port inside the test JVM, tokens
  signed with generated RSA keys; no network, no Keycloak) drives `OidcJwtDecodersTest` (every
  rejection, rotation, outage, rate limit) and `OidcModeIT` (whole app: provisioning, collision,
  disabled account, concurrency, local endpoints off). Not verified here: against a real Keycloak,
  and `SERVER_FORWARD_HEADERS_STRATEGY=native` behind a real proxy.
