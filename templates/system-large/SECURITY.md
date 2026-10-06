# Security policy

## Reporting a vulnerability

Report privately through GitHub Security Advisories on this repository (Security, then Report a
vulnerability). Do not open a public issue. Expect an acknowledgement within 3 working days.

## What this repository holds

Deployment definitions, not secrets. Secrets are ExternalSecret references; the only credential-like
strings are obviously fake development values in `deploy/kustomize/examples/fake-dev`, marked
`standards-allow: secret`. If you find a real secret, treat it as leaked: rotate it first, then report.

## Hardening enforced by tests or scans

Restricted pod security on every workload, default-deny NetworkPolicy, digest-only images in
production, no Secret or RBAC objects syncable from git (Argo CD AppProject whitelist), encrypted
Terraform state and private cluster endpoints in production (checkov, trivy).

## Not covered

Nothing in this repository has been applied to a live cluster; review the plan for your environment.
