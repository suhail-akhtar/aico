# Decisions

Short records of why this system is shaped the way it is. Add one when you change a decision.

## 1. A modular monolith plus a SPA, not microservices

One deployable API (run twice: web replicas and one worker) with Spring Modulith modules that talk
through events. Teams and scaling needs of a small-to-medium company do not pay for network
boundaries yet; the module boundaries are enforced by tests (`ModularityTest`, `ArchitectureTest`),
so a module can be extracted later along its event boundary. Rejected: separate services per
feature (operational cost with no matching need), CQRS and event sourcing (a growth step, not a
default).

## 2. Browser sign-in is a backend-for-frontend

The API is the OIDC client; the browser holds only an HttpOnly cookie, the session lives in Valkey.
No token is reachable by JavaScript, so XSS cannot steal one. Writes need the CSRF header. Rejected:
tokens in the SPA (localStorage or memory), a separate BFF service (another deployable for no gain).

## 3. A transactional outbox with an inbox, delivered in-process

Spring Modulith's event publication registry is the outbox: the event row commits with the business
change; a listener runs after commit; a failed delivery stays pending and the worker republishes it
(`APP_JOBS_ENABLED=true` on the worker only). Consumers record handled event ids (inbox) so redelivery
is harmless. Rejected: a message broker now (it adds an operated system; the large stage swaps the
transport behind the same events), dual writes (lose messages).

## 4. Traefik with file configuration, never the Docker socket

One gateway, routes in `infra/traefik/dynamic.yml`, static configuration as command flags. The identity
provider has its own entry point on the port it is published on, because that port is part of the
OIDC issuer URL which the browser and the API must see identically (`idp.localhost` is a network alias
inside compose). Rejected: mounting the Docker socket into the proxy; path-prefixing Keycloak.

## 5. Choices that keep licences clean

Valkey (not Redis 8), SeaweedFS (not MinIO), Keycloak (Apache 2.0), flagd/OpenFeature, Mailpit,
PostgreSQL. No source-available or relicensed component is required.

## 6. Hardened containers by default

`cap_drop: ALL`, `no-new-privileges`, read-only root filesystems where the image allows, named volumes,
secrets only from `.env` with `${VAR:?}` guards, published ports on 127.0.0.1. Exceptions are written
next to the service: PostgreSQL keeps the capabilities its entrypoint needs; SeaweedFS runs as its own
user (1000) because with no capabilities root cannot write the image's `/data`.

## Versions (resolved and verified 2026-10-06)

| Component | Version |
|---|---|
| Java (build and runtime image) | Temurin 25 (`maven:3.9-eclipse-temurin-25`, `eclipse-temurin:25-jre-alpine`, digest pinned) |
| Spring Boot | 4.1.1 |
| Spring Modulith | 2.1.1 |
| Flyway | 13.9.0 (override of the BOM's 12.4.0) |
| Tomcat | 11.0.26 (security override of the BOM's 11.0.24) |
| Jackson | 3.1.7 and 2.21.7 (security overrides) |
| springdoc-openapi | 3.1.1 |
| AWS SDK for Java (S3) | 2.55.11 |
| OpenFeature SDK / flagd provider | 1.23.0 / 0.14.2 |
| Error Prone / NullAway | 2.50.0 / 0.14.2 |
| Spotless / google-java-format | 3.10.3 / 1.36.0 |
| SpotBugs (plugin / engine) / FindSecBugs | 4.10.4.1 / 4.10.4 / 1.14.0 |
| JaCoCo | 0.8.15 (85% line gate) |
| PostgreSQL | 18.6 (alpine, digest pinned) |
| Valkey | 9.1.2 (alpine) |
| Keycloak | 26.8.0 |
| Traefik | 3.7.13 |
| flagd | 0.17.0 |
| SeaweedFS | 4.48 |
| Mailpit | 1.31.4 |
| nginx (unprivileged) | 1.30.5 |
| Node (build image) | 24.21.0 |
| React / React DOM | 19.3.0 |
| Vite / Vitest | 8.3.2 / 5.0.3 |
| TypeScript | 6.0.3 |
| Biome | 2.5.15 |

Every dependency in `pom.xml` and `package.json` is used; the overrides in `pom.xml` say which
advisory each one answers. Remove an override when Spring Boot's BOM catches up.
