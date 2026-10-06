# Extending

## Add a workload (a second worker, an extracted module)

1. Add `services.<name>` to `deploy/helm/system/values.yaml` (copy `worker`): image, env, resources,
   `networkPolicy.ingressFrom` and `egress` (peers are named in `networkPolicy.peers`).
2. Add its sizing to `values-dev|staging|prod.yaml`.
3. Add cases to `tests/` (deployment, networkpolicy, scaling) and update the counts they assert.
4. `sh scripts/check.sh helm`.

A workload that needs its own database role: add a `managed.roles` entry and a `Database` object in
`deploy/kustomize/base`, an ExternalSecret next to `system-db-app`, and the per-environment key
patches in each overlay.

## Add an environment

A `values-<env>.yaml`, a `deploy/kustomize/overlays/<env>`, an element in the Argo CD
ApplicationSets (or a Flux `clusters/<env>` and `apps/<env>`), `infra/terraform/envs/<env>`, and the
name in the `environment` enum of `values.schema.json` (unknown names are rejected on purpose).

## Add a peer the app talks to

A named entry under `networkPolicy.peers` in values.yaml, then `{to: <peer>, ports: [..]}` in the
workload's egress. An unknown peer name fails the render (`unknown peer`).

## Add an alert or an SLO

Edit `observability/slo/slos.yaml` (the contract), the two rule files, and add a case to
`observability/slo/tests/slo.test.yaml`. Then bring the wrapper `prometheusrule.yaml` in step with
the rule files (`sh scripts/check.sh rules drift` shows the difference).

## Upgrade a pinned tool

Change the version in `scripts/check.sh` (one place), run every group, and record it in
`.aico/decisions.md`. Dependabot proposes Terraform provider and Actions bumps.
