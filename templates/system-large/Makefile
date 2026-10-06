# Every verb runs the same containerised checks as CI. Windows without make: run `sh scripts/check.sh`.
.PHONY: check lint helm kustomize terraform scan
check:
	sh scripts/check.sh
lint:
	sh scripts/check.sh yaml
helm:
	sh scripts/check.sh helm
kustomize:
	sh scripts/check.sh kustomize
terraform:
	sh scripts/check.sh terraform
scan:
	sh scripts/check.sh scan
