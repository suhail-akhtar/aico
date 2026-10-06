# system-large

The large tier of the system bundles: the medium tier's application (Spring Modulith API
`system-api`, React web `system-web`, both on port 8080, probes `/healthz` and `/readyz`)
deployed to Kubernetes. Nothing here has run on a real cluster.

## Layout
- `deploy/helm/system` one chart; the `services` map in values.yaml (web, api, worker) drives
  every Deployment, Service, HPA, PDB, NetworkPolicy, Ingress and ExternalSecret. Tests in `tests/`.
- `deploy/kustomize` platform layer per environment (namespace, quota, default-deny, CloudNativePG, backups).
- `deploy/gitops` Argo CD and Flux. `infra/terraform` network, cluster, database, secrets.
- `observability` collector, SLO rules (promtool-tested), alerts, dashboards.
- `services/` is where the medium tier's `services/api` and `services/web` go (not duplicated here).

## Rules
- Run `sh scripts/check.sh` (needs Docker only) before claiming anything works. Say plainly that
  passing means well-formed and policy-clean, not that a cluster accepted it.
- Add a workload by adding a `services.<name>` entry plus a helm-unittest case. Never special-case a name in a template.
- Secrets are references (ExternalSecret), never values. Production images are pinned by digest.
- Policies only deny by default: add a NetworkPolicy peer or egress deliberately and update the matrix test.
- Keep `observability/*/prometheusrule.yaml` in step with the rule files (the `drift` check fails otherwise).
- Tool versions are pinned in `scripts/check.sh`; `.aico/decisions.md` records why.
