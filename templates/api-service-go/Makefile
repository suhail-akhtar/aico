# Same verbs in every AICO starter: setup dev fmt lint test cov audit build check run.
# Everything here also runs without a local Go toolchain: `make docker-check`
# (or any `docker compose run --rm tools make <verb>`) uses the pinned tools image.

SHELL := /bin/sh
.DEFAULT_GOAL := help

# Pinned tool versions. The tools image (Dockerfile) installs the same ones; a
# test in CI would catch a mismatch because the lint/audit results would differ.
GOLANGCI_LINT_VERSION := v2.14.0
GOVULNCHECK_VERSION   := v1.8.0
CYCLONEDX_VERSION     := v1.12.0
OAPI_CODEGEN_VERSION  := v2.8.0
SQLC_VERSION          := v1.31.1

# On the host these run through `go run pkg@version` (slow once, then cached).
# The tools image sets them to the pre-installed binaries.
GO            ?= go
GOLANGCI_LINT ?= $(GO) run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION)
GOVULNCHECK   ?= $(GO) run golang.org/x/vuln/cmd/govulncheck@$(GOVULNCHECK_VERSION)
CYCLONEDX     ?= $(GO) run github.com/CycloneDX/cyclonedx-gomod/cmd/cyclonedx-gomod@$(CYCLONEDX_VERSION)
OAPI_CODEGEN  ?= $(GO) run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@$(OAPI_CODEGEN_VERSION)
SQLC          ?= $(GO) run github.com/sqlc-dev/sqlc/cmd/sqlc@$(SQLC_VERSION)

MIN_COVERAGE ?= 85
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS := -s -w \
	-X example.com/api-service/internal/platform/version.Version=$(VERSION) \
	-X example.com/api-service/internal/platform/version.Commit=$(COMMIT) \
	-X example.com/api-service/internal/platform/version.Date=$(DATE)

# .env supplies POSTGRES_PASSWORD; the integration tests use the compose database.
-include .env
TEST_DATABASE_URL ?= postgres://app:$(POSTGRES_PASSWORD)@127.0.0.1:$(or $(DB_PORT),5432)/app?sslmode=disable
export TEST_DATABASE_URL

.PHONY: help setup dev run fmt fmt-check lint vet test cov audit build check sbom gen gen-check tidy-check \
	db-up db-down docker docker-check seed clean

help: ## list the verbs
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*## /\t/' | sort

setup: ## create .env with generated secrets (never overwrites)
	@test -f .env || { \
	  gen() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }; \
	  sed -e "s/change-me-db-password/$$(gen)/" -e "s/change-me-seed-password/$$(gen)/" .env.example > .env; \
	  echo "created .env"; }

dev: ## API + PostgreSQL in containers, rebuilt on change
	docker compose up --build --watch

run: build ## run the compiled binary against the compose database
	docker compose up -d --wait db
	APP_ENV=development PORT=$${PORT:-8080} \
	DATABASE_URL=$(TEST_DATABASE_URL) ./bin/server

fmt: ## format (gofumpt + goimports)
	$(GOLANGCI_LINT) fmt

fmt-check: ## fail if anything is unformatted
	$(GOLANGCI_LINT) fmt --diff

lint: ## golangci-lint (staticcheck, gosec, errcheck, govet, revive, ...)
	$(GOLANGCI_LINT) run --max-same-issues=0 ./...

vet: ## go vet + compile everything
	$(GO) build ./...
	$(GO) vet ./...

test: ## fast tests (PostgreSQL tests skip when TEST_DATABASE_URL is unreachable-unset)
	$(GO) test -race -count=1 ./...

cov: ## full tests with PostgreSQL, race detector and the coverage gate (needs `make db-up`)
	REQUIRE_DB=1 $(GO) test -race -count=1 -covermode=atomic -coverpkg=./internal/... -coverprofile=coverage.raw ./...
	@grep -v -e '/internal/api/api.gen.go' -e '/internal/platform/database/dbgen/' coverage.raw > coverage.out
	@$(GO) tool cover -func=coverage.out | tail -n 1
	@$(GO) tool cover -func=coverage.out | awk -v min=$(MIN_COVERAGE) '/^total:/ { gsub("%","",$$3); if ($$3+0 < min) { printf "coverage %s%% is below the %s%% gate\n", $$3, min; exit 1 } }'

audit: ## go mod verify + govulncheck (reviewed exceptions: .audit-allowlist)
	$(GO) mod verify
	GOVULNCHECK="$(GOVULNCHECK)" sh scripts/audit.sh

build: ## static binary in bin/server (version stamped)
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o bin/server ./cmd/server

sbom: ## CycloneDX SBOM of the compiled dependencies -> sbom.cdx.json
	$(CYCLONEDX) app -json -main cmd/server -output sbom.cdx.json -licenses .

gen: ## regenerate internal/api (oapi-codegen) and the sqlc queries
	$(OAPI_CODEGEN) -config api/oapi-codegen.yaml api/openapi.yaml
	$(SQLC) generate

gen-check: gen ## fail if generated code is out of date with its inputs
	@git diff --quiet --exit-code -- internal/api internal/platform/database/dbgen || { echo "generated code is stale: run make gen and commit"; git diff --stat -- internal/api internal/platform/database/dbgen; exit 1; }

tidy-check: ## go.mod and go.sum are tidy
	$(GO) mod tidy
	@git diff --quiet --exit-code -- go.mod go.sum || { echo "go.mod/go.sum are not tidy: run go mod tidy and commit"; exit 1; }

check: fmt-check lint vet tidy-check cov audit ## everything CI runs

db-up: ## start PostgreSQL (published on 127.0.0.1:$(DB_PORT), default 5432)
	docker compose up -d --wait db

db-down: ## stop everything and delete the database volume
	docker compose down -v

seed: ## demo account + sample items (development only)
	docker compose --profile tools run --rm seed

docker: ## production image
	docker build --build-arg VERSION=$(VERSION) --build-arg COMMIT=$(COMMIT) --build-arg DATE=$(DATE) -t api-service:$(VERSION) .

docker-check: ## `make check` inside the pinned tools image (no local Go needed)
	docker compose --profile tools run --rm tools make check

clean: ## remove build output
	rm -rf bin coverage.raw coverage.out sbom.cdx.json
