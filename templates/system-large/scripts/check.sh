#!/bin/sh
# Every static check this bundle can run without a cluster, cloud account or secret, each in a
# pinned container so a laptop and CI give the same answer: `sh scripts/check.sh [group ...]`.
# Groups: yaml helm kustomize terraform otel rules drift scan (default: all).
#
# Why a script and not a Makefile recipe per tool: the same file runs in CI, on a laptop and
# under the AICO verification script, so there is one definition of "passed".
# What it does not do: apply anything to a cluster, plan against a cloud account, or start a
# service. Passing means the manifests are well-formed, schema-valid and policy-clean, not that
# a cluster accepted them (see docs/ARCHITECTURE.md, "What is verified").
# Output: one line per check, "ok <name>" or "FAIL <name>" followed by the tool's output.
set -u

HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))   # a path Docker understands, also on Windows
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

HELM=alpine/helm:4.3.0
UNITTEST=helmunittest/helm-unittest:4.2.4-1.2.1
KUBECONFORM=ghcr.io/yannh/kubeconform:v0.7.0
KUSTOMIZE=registry.k8s.io/kustomize/kustomize:v5.7.1
TERRAFORM=hashicorp/terraform:1.16.5
TFLINT=ghcr.io/terraform-linters/tflint:v0.62.0
OTELCOL=otel/opentelemetry-collector-contrib:0.162.0
PROMETHEUS=prom/prometheus:v3.15.0
TRIVY=aquasec/trivy:0.74.0
CHECKOV=bridgecrew/checkov:3.3.23
PYTHON=python:3.14-slim
YAMLLINT=1.38.0
K8S_VERSION=1.34.0
CRDS='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

PASS=0
FAIL=0
TMP=$(mktemp -d)
TMPW=$(cd "$TMP" && (pwd -W 2>/dev/null || pwd))   # the same directory, as Docker sees it
RENDERED="$HERE/deploy/kustomize/overlays/rendered-chart-example/chart-rendered.yaml"
trap 'rm -rf "$TMP"; rm -f "$RENDERED"' EXIT

result() { # result <name> <exit code> <output file>
  if [ "$2" -eq 0 ]; then
    PASS=$((PASS + 1))
    echo "ok   $1"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL $1"
    tail -40 "$3" | sed 's/^/       /'
  fi
}
conform() {
  docker run --rm -i "$KUBECONFORM" -strict -summary -kubernetes-version "$K8S_VERSION" -schema-location default -schema-location "$CRDS" -
}

WANTED="${*:-yaml helm kustomize terraform otel rules drift scan}"
want() {
  for g in $WANTED; do [ "$g" = "$1" ] && return 0; done
  return 1
}

if want helm; then
  for set in "defaults:" "dev:values-dev.yaml" "staging:values-staging.yaml" "prod:values-prod.yaml" "ci-minimal:ci/minimal-values.yaml" "ci-all-features:ci/all-features-values.yaml"; do
    name=${set%%:*}
    extra=${set#*:}
    args=""
    [ -n "$extra" ] && args="-f /chart/$extra"
    docker run --rm -v "$ROOT/deploy/helm/system:/chart:ro" "$HELM" lint /chart --strict $args >"$TMP/o" 2>&1
    result "helm lint ($name)" $? "$TMP/o"
    docker run --rm -v "$ROOT/deploy/helm/system:/chart:ro" "$HELM" template system /chart --namespace system $args 2>"$TMP/e" | conform >"$TMP/o" 2>&1
    rc=$?
    if [ -s "$TMP/e" ]; then
      cat "$TMP/e" >>"$TMP/o"
      rc=1
    fi
    result "helm template + kubeconform ($name)" $rc "$TMP/o"
  done
  docker run --rm -v "$ROOT/deploy/helm/system:/src:ro" --entrypoint sh "$UNITTEST" -c 'cp -r /src /tmp/apps && cd /tmp/apps && helm unittest .' >"$TMP/o" 2>&1
  result "helm-unittest" $? "$TMP/o"
  # Production must refuse a tag-only image: render with the web digest removed.
  docker run --rm -v "$ROOT/deploy/helm/system:/chart:ro" "$HELM" template system /chart -f /chart/values-prod.yaml --set services.web.image.digest= >"$TMP/o" 2>&1
  if grep -q "image.digest is required" "$TMP/o"; then result "prod refuses a tag-only image" 0 "$TMP/o"; else result "prod refuses a tag-only image" 1 "$TMP/o"; fi
fi

if want kustomize; then
  for env in dev staging prod; do
    docker run --rm -v "$ROOT/deploy/kustomize:/k:ro" "$KUSTOMIZE" build "/k/overlays/$env" 2>"$TMP/e" | conform >"$TMP/o" 2>&1
    rc=$?
    if [ -s "$TMP/e" ]; then
      cat "$TMP/e" >>"$TMP/o"
      rc=1
    fi
    result "kustomize build + kubeconform ($env)" $rc "$TMP/o"
  done
  # Chart + kustomize composition: render the chart next to the overlay, build, clean up.
  docker run --rm -v "$ROOT/deploy/helm/system:/chart:ro" "$HELM" template system /chart --namespace system-staging -f /chart/values-staging.yaml >"$RENDERED" 2>"$TMP/e"
  docker run --rm -v "$ROOT/deploy/kustomize:/k:ro" "$KUSTOMIZE" build /k/overlays/rendered-chart-example 2>>"$TMP/e" | conform >"$TMP/o" 2>&1
  rc=$?
  if [ -s "$TMP/e" ]; then
    cat "$TMP/e" >>"$TMP/o"
    rc=1
  fi
  rm -f "$RENDERED"
  result "kustomize chart composition + kubeconform" $rc "$TMP/o"
fi

if want terraform; then
  docker run --rm -v "$ROOT/infra/terraform:/tf:ro" "$TERRAFORM" fmt -check -recursive -diff /tf >"$TMP/o" 2>&1
  result "terraform fmt" $? "$TMP/o"
  docker volume create aico-tf-plugin-cache >/dev/null 2>&1
  for env in dev prod; do
    docker run --rm -v "$ROOT/infra/terraform:/tf:ro" -v aico-tf-plugin-cache:/cache -e TF_DATA_DIR=/tmp/tfdata -e TF_PLUGIN_CACHE_DIR=/cache -e TF_IN_AUTOMATION=1 \
      --entrypoint sh "$TERRAFORM" -c "terraform -chdir=/tf/envs/$env init -backend=false -input=false -lockfile=readonly >/dev/null && terraform -chdir=/tf/envs/$env validate" >"$TMP/o" 2>&1
    result "terraform validate (envs/$env)" $? "$TMP/o"
  done
  docker run --rm -v "$ROOT/infra/terraform:/tf:ro" -v aico-tf-plugin-cache:/plugins -e TFLINT_PLUGIN_DIR=/plugins --entrypoint sh "$TFLINT" \
    -c "cd /tf && tflint --init --config /tf/.tflint.hcl >/dev/null && tflint --recursive --config /tf/.tflint.hcl" >"$TMP/o" 2>&1
  result "tflint (terraform + aws ruleset)" $? "$TMP/o"
  docker run --rm -v "$ROOT/infra/terraform:/tf:ro" "$CHECKOV" -d /tf --config-file /tf/.checkov.yaml --quiet --compact >"$TMP/o" 2>&1
  result "checkov (terraform)" $? "$TMP/o"
fi

if want otel; then
  awk '/^  relay: \|/{f=1;next} f&&/^    /{sub(/^    /,"");print;next} f&&!/^$/{f=0}' "$HERE/observability/otel-collector/k8s/configmap.yaml" >"$TMP/relay.yaml"
  docker run --rm -v "$TMPW/relay.yaml:/c.yaml:ro" "$OTELCOL" validate --config=/c.yaml >"$TMP/o" 2>&1
  result "otel collector config (kubernetes relay)" $? "$TMP/o"
  docker run --rm -v "$ROOT/observability/otel-collector/docker/config.yaml:/c.yaml:ro" "$OTELCOL" validate --config=/c.yaml >"$TMP/o" 2>&1
  result "otel collector config (docker)" $? "$TMP/o"
fi

if want rules; then
  docker run --rm --entrypoint promtool -v "$ROOT/observability:/o:ro" "$PROMETHEUS" check rules /o/alerts/platform.rules.yaml /o/slo/slo-recording.rules.yaml /o/slo/slo-alerts.rules.yaml >"$TMP/o" 2>&1
  result "promtool check rules" $? "$TMP/o"
  docker run --rm --entrypoint promtool -v "$ROOT/observability:/o:ro" "$PROMETHEUS" test rules /o/slo/tests/slo.test.yaml >"$TMP/o" 2>&1
  result "promtool test rules (SLO burn alerts)" $? "$TMP/o"
  for f in alerts/prometheusrule.yaml slo/prometheusrule.yaml; do
    docker run --rm -v "$ROOT/observability/$f:/p.yaml:ro" "$KUBECONFORM" -strict -summary -kubernetes-version "$K8S_VERSION" -schema-location default -schema-location "$CRDS" /p.yaml >"$TMP/o" 2>&1
    result "kubeconform observability/$f" $? "$TMP/o"
  done
fi

if want drift; then
  norm() { sed -e '1,/^ *groups:/d' -e 's/^ *//' -e '/^#/d' -e '/^$/d' "$@"; }
  O="$HERE/observability"
  norm "$O/alerts/platform.rules.yaml" >"$TMP/a"
  norm "$O/alerts/prometheusrule.yaml" >"$TMP/b"
  diff "$TMP/a" "$TMP/b" >"$TMP/o" 2>&1
  result "alerts/prometheusrule.yaml matches platform.rules.yaml" $? "$TMP/o"
  { norm "$O/slo/slo-recording.rules.yaml"; norm "$O/slo/slo-alerts.rules.yaml"; } >"$TMP/a"
  norm "$O/slo/prometheusrule.yaml" >"$TMP/b"
  diff "$TMP/a" "$TMP/b" >"$TMP/o" 2>&1
  result "slo/prometheusrule.yaml matches the SLO rule files" $? "$TMP/o"
fi

if want yaml; then
  docker run --rm -v "$ROOT:/src:ro" "$PYTHON" sh -c "pip install -q --disable-pip-version-check yamllint==$YAMLLINT 2>&1 | grep -v WARNING; cd /src && yamllint --strict -c .yamllint ." >"$TMP/o" 2>&1
  result "yamllint" $? "$TMP/o"
fi

if want scan; then
  docker run --rm -v "$ROOT:/src:ro" -v aico-trivy-cache:/root/.cache "$TRIVY" config --severity HIGH,CRITICAL --exit-code 1 --ignorefile /src/infra/terraform/.trivyignore --skip-dirs /src/deploy/helm/system/tests /src >"$TMP/o" 2>&1
  result "trivy config (HIGH, CRITICAL)" $? "$TMP/o"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
