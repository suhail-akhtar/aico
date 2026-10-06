# system-large

The **large** tier of the AICO system bundles: Kubernetes, GitOps, Terraform and observability for
the application the medium tier builds (`system-api`, `system-web`, and a worker that is the API image
with the background jobs on).

| | small | medium | large (this) |
|---|---|---|---|
| Shape | one process | Spring Modulith API + React | the same app on Kubernetes |
| Runs on | a laptop | Docker Compose | a cluster, three environments |
| Adds | | OIDC, outbox, S3, Valkey, flags, traces | Helm, GitOps, Terraform, SLOs, backups, network policy |

> **Status: statically verified, never applied.** Every manifest is linted, schema-checked and
> policy-scanned in pinned containers (`sh scripts/check.sh`). No chart, overlay or Terraform
> module here has been applied to a real cluster or cloud account. Expect to find environment
> details (ingress class, storage class, CIDRs, registry, secret store) that only a cluster tells you.

## Use it

```sh
sh scripts/check.sh            # everything, Docker only (about 5 minutes the first time)
sh scripts/check.sh helm       # one group: yaml helm kustomize terraform otel rules drift scan
make check                     # the same
```

1. Put the medium tier's `services/api` and `services/web` under `services/` and build the images
   (`ghcr.io/example-org/system-api`, `system-web`; change `example-org` in values.yaml).
2. `infra/terraform/envs/<env>`: copy `terraform.tfvars.example` and `backend.tf.example`, then plan.
3. Install the platform layer (`deploy/gitops/argocd/platform` or `deploy/gitops/flux`), then the
   environment: Argo CD ApplicationSets or Flux HelmReleases, or by hand:
   `helm upgrade --install system deploy/helm/system -n system-dev -f deploy/helm/system/values-dev.yaml`.
4. Fill the secret manager: one remote secret per environment, `system/<env>/api`
   (`DATABASE_PASSWORD VALKEY_PASSWORD OIDC_CLIENT_SECRET S3_ACCESS_KEY S3_SECRET_KEY SMTP_PASSWORD`),
   and `system/<env>/db-backup`. The worker reads the API's secret.

## What you must bring

Keycloak (or another OIDC provider), Valkey, flagd, an S3-compatible bucket and an SMTP relay are
**prerequisites**, not part of this bundle: the chart and its NetworkPolicies assume Services named
`keycloak`, `valkey` and `flagd` in the release namespace, and external S3 and SMTP. The medium tier
shows the contract; use your operators or managed services. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Docs: [ARCHITECTURE](docs/ARCHITECTURE.md), [EXTENDING](docs/EXTENDING.md), [SECURITY](SECURITY.md),
[decisions](.aico/decisions.md). Licence: MIT.
