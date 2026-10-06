# __APP_TITLE__

Spring Boot 4 API on Java 25: Web MVC (virtual threads), JPA, Flyway, PostgreSQL, JWT
resource server. aico runs it with `mvnw spring-boot:test-run` (throwaway database, demo user)
and waits for "Dev seed ready".

## Layout (package by feature, `com.example.app`)

- `Application.java` — composition root. Rarely changes.
- `shared/` — kernel: errors, paging, config, filters, security, OpenAPI. Knows no feature.
- `items/` — **the worked feature**. Copy it. `domain/` (plain Java + port), `app/` (service),
  `infra/` (JPA adapter), `api/` (controller + DTO records).
- `identity/` — register, login, local token issuer; in `APP_AUTH_MODE=oidc` it creates an account
  on first sight of a token `sub` instead (`OIDC_ISSUER`/`OIDC_JWKS_URI`/`OIDC_AUDIENCE`).
- `src/main/resources/db/migration/V<n>__*.sql` — Flyway. Add a file; never edit one.

## Conventions

- Layers point one way: api -> app -> domain <- infra. Features never import each other.
  `ArchitectureTest` and `ModularityTest` fail the build otherwise.
- The owner always comes from the token (`AuthenticatedUser.id`), never the body.
  Repository methods take the owner; foreign ids answer 404.
- Wire format: snake_case JSON (one Jackson setting), lists keyset-paged (`limit`, `cursor`,
  `next_cursor`), never page/size.
- Errors are domain exceptions (`shared/error`); `ProblemDetailsAdvice` makes RFC 9457 bodies.
- Config is env-only, mapped in `application.properties`, validated in `AppProperties`.
- Null-safety: Error Prone + NullAway run on every compile; use `@Nullable`.

## Checks

`mvnw -DskipTests compile` (types), `mvnw test` (fast), `mvnw verify` (everything: format,
SpotBugs, integration tests on PostgreSQL, 85% coverage). `RunChecks` runs them. Then
`AppManage start` and `VerifyApp` `/readyz`, `/swagger-ui/index.html`, a login and `/api/v1/items`.
