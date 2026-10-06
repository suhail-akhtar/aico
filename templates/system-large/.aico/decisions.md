# Decisions - system-large

## 1. This tier deploys the medium tier's application
The same two images (`system-api`, `system-web`, port 8080, `/healthz` and `/readyz`) plus a worker
that is the API image with `APP_JOBS_ENABLED=true`, exactly as the medium compose runs it. The
assembled prototype was a five-service split (core, billing, notifications, search, NATS); it was
reduced to match the application, because deploying services that have no code cannot be tested
against anything. Rejected: keeping five services as a "future" shape.

## 2. One database, one role
The medium tier has a single database `app`. The cluster bootstraps `app` owned by role `app`, behind
PgBouncer in session mode (Flyway advisory locks and prepared statements need it). The worker reads
the API's remote secret (`secrets.remoteName`), so there is one password to rotate.

## 3. Metrics are pushed, not scraped
The medium API exposes only the health endpoints and exports OTLP, so no ServiceMonitor is on by
default and the SLO and alert rules use `job="system-api"` (the OTLP service name). Unverified: that
the collector's remote write keeps `http_server_requests_seconds_*` and that label.

## 4. Prerequisites stay out
Keycloak, Valkey, flagd, S3 and SMTP are not deployed by this bundle (see ARCHITECTURE).

## 5. Verification is static, in pinned containers
One script, `scripts/check.sh`, so CI, a laptop and AICO's verification run the same commands.
Nothing was applied to a cluster. Kubernetes schema version 1.34.0 for kubeconform.

## Resolved tool versions (2026-10-06; the versions the checks ran with)
| Tool | Version |
|---|---|
| Helm | 4.3.0 (alpine/helm) |
| helm-unittest | image helmunittest/helm-unittest:4.2.4-1.2.1 |
| kubeconform | v0.7.0 (CRD schemas fetched from datreeio/CRDs-catalog at run time) |
| kustomize | v5.7.1 |
| Terraform | 1.16.5; AWS provider locked in `envs/*/.terraform.lock.hcl` (`~> 6.60`) |
| tflint | v0.62.0 with the AWS ruleset 0.49.0 |
| checkov | 3.3.23 |
| trivy | 0.74.0 |
| OpenTelemetry Collector contrib | 0.162.0 |
| Prometheus (promtool) | v3.15.0 |
| yamllint | 1.38.0 |
| PostgreSQL (CloudNativePG image) | ghcr.io/cloudnative-pg/postgresql:18.6-standard-trixie |

## Licences
No relicensed cache or object-store server (Redis 8, MinIO) is used or referenced; the cache is Valkey. Terraform has been under the
Business Source License since 1.6: here it runs as a verification tool in a container and is not
redistributed. A team that cannot accept the BSL can run the same files with OpenTofu.
