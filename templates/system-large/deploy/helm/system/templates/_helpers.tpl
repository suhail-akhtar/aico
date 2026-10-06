{{/*
Why this file exists: every resource of every service needs the same names, labels,
selector labels and image reference. Keeping them in one place is what makes the
NetworkPolicy peer lookup (service key -> pod selector) trustworthy: the Deployment,
the Service and the policy all call the same helper.

Resource names are the plain service key (web, api, worker), not release-prefixed.
The services reach each other as http://api:8080 and that must match docker
compose; the cost is one release per namespace (documented in the README).
*/}}

{{- define "system.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}

{{- define "system.labels" -}}
{{ include "system.selectorLabels" . }}
app.kubernetes.io/component: {{ .name }}
app.kubernetes.io/part-of: system
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
{{- with .root.Values.global.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* Image reference: a digest wins over a tag; production may forbid tag-only images. */}}
{{- define "system.image" -}}
{{- $img := .svc.image -}}
{{- if $img.digest -}}
{{- if $img.tag -}}
{{ printf "%s:%s@%s" $img.repository $img.tag $img.digest }}
{{- else -}}
{{ printf "%s@%s" $img.repository $img.digest }}
{{- end -}}
{{- else -}}
{{- if .root.Values.global.requireImageDigest -}}
{{- fail (printf "services.%s.image.digest is required when global.requireImageDigest is true (tag-only images are mutable); the promotion PR writes the digest" .name) -}}
{{- end -}}
{{- if not $img.tag -}}
{{- fail (printf "services.%s.image needs a tag or a digest" .name) -}}
{{- end -}}
{{ printf "%s:%s" $img.repository $img.tag }}
{{- end -}}
{{- end -}}

{{/* Non-secret environment of one service: global.env (Spring services only) overlaid by the service's own env. */}}
{{- define "system.env" -}}
{{- $env := dict -}}
{{- if .svc.springEnv -}}
{{- $env = merge $env (deepCopy (default (dict) .root.Values.global.env)) -}}
{{- end -}}
{{- $env = mergeOverwrite $env (deepCopy (default (dict) .svc.env)) -}}
{{- if .svc.springEnv -}}
{{- $_ := set $env "OTEL_SERVICE_NAME" (printf "system-%s" .name) -}}
{{- $_ := set $env "OTEL_RESOURCE_ATTRIBUTES" (printf "deployment.environment=%s,service.namespace=system" .root.Values.global.environment) -}}
{{- end -}}
{{- toYaml $env -}}
{{- end -}}

{{/*
Resolve a NetworkPolicy peer by name. A key of .Values.services selects that service's
pods (same namespace); anything else must be a key of networkPolicy.peers. An unknown
name fails the render: a typo in an allow rule must not silently become a deny (or worse).
Output: a YAML list of NetworkPolicyPeer objects.
*/}}
{{- define "system.peer" -}}
{{- $root := .root -}}
{{- $name := .peer -}}
{{- if hasKey $root.Values.services $name -}}
- podSelector:
    matchLabels:
      app.kubernetes.io/name: {{ $name }}
      app.kubernetes.io/instance: {{ $root.Release.Name }}
{{- else if hasKey $root.Values.networkPolicy.peers $name -}}
{{ toYaml (get $root.Values.networkPolicy.peers $name) }}
{{- else -}}
{{- fail (printf "networkPolicy: unknown peer %q (not a service and not in networkPolicy.peers)" $name) -}}
{{- end -}}
{{- end -}}
