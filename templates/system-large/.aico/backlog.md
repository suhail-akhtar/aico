# Backlog - system-large

Tick a box only when its "Done when" has been observed. Append iterations; never rewrite the ones above.

## Iteration 0 - from the template

- [x] One Helm chart for web, api and worker with the restricted pod security profile.
      Done when: `helm lint --strict` passes for six value sets and helm-unittest passes (49 tests).
- [x] A NetworkPolicy matrix with default deny, asserted by tests.
      Done when: `tests/networkpolicy_test.yaml` passes.
- [x] Secrets only as ExternalSecret references; production refuses tag-only images.
      Done when: `tests/externalsecret_test.yaml` passes and check.sh reports "prod refuses a tag-only image".
- [x] Platform layer (namespace, quota, default-deny, CloudNativePG, backups) per environment.
      Done when: `kustomize build` of dev, staging and prod passes kubeconform with CRD schemas.
- [x] Argo CD and Flux definitions, Terraform modules (network, k8s, db, secrets).
      Done when: yamllint, `terraform validate` (dev, prod), tflint and checkov pass.
- [x] Observability: collector config, SLO burn-rate rules with unit tests, alerts, dashboards.
      Done when: `otelcol validate`, `promtool check rules` and `promtool test rules` pass.
- [x] Every static check passes in pinned containers.
      Done when: `sh scripts/check.sh` exits 0.

## Iteration 1 - make it real

- [ ] Apply the dev environment to a kind or k3d cluster with the fake secret store.
      Done when: `kubectl rollout status` succeeds for web, api and worker and `/readyz` answers through the ingress.
- [ ] Prove the SLO and alert metric names against a running Prometheus.
      Done when: each expression in `observability/` returns data from the live stack.
- [ ] Write the runbooks the alerts link to.
      Done when: every `runbook_url` resolves to a page that names a first action.
- [ ] Restore a CloudNativePG backup into a scratch cluster.
      Done when: the restored cluster answers a query for a row written before the backup.
- [ ] Run `terraform plan` against a real account; replace the example CIDRs, domains and registry.
      Done when: the plan shows only intended resources.
