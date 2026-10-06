# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial scaffold from the AICO `system-large` template: Helm chart (web, api, worker), kustomize
  platform overlays, Argo CD and Flux, Terraform modules, OpenTelemetry, SLO rules and dashboards,
  and `scripts/check.sh` (static checks in pinned containers).
