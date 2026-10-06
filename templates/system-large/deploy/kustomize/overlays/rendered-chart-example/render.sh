#!/bin/sh
# Renders the Helm chart into chart-rendered.yaml next to this file so Kustomize can compose
# it. Uses a local helm when there is one, otherwise the pinned helm container (no install).
# Why a script and not kustomize's helmCharts generator: that needs `--enable-helm` and a
# helm binary on the machine running kustomize, which neither Argo CD nor the pinned
# kustomize image provides by default.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
chart=$(cd "$here/../../../helm/system" && pwd)
env_name=${1:-staging}
if command -v helm >/dev/null 2>&1; then
  helm template system "$chart" --namespace "system-$env_name" -f "$chart/values-$env_name.yaml" >"$here/chart-rendered.yaml"
else
  MSYS_NO_PATHCONV=1 docker run --rm -v "$chart:/chart:ro" alpine/helm:4.3.0 \
    template system /chart --namespace "system-$env_name" -f "/chart/values-$env_name.yaml" >"$here/chart-rendered.yaml"
fi
echo "wrote $here/chart-rendered.yaml"
