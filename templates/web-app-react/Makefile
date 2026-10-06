# The same verbs in every AICO starter. `make help` lists them.
# No `make` (Windows)? Each target is one `npm run ...` line: run it directly.
# No Node 24 on the machine? `make docker-check` runs the checks in the pinned Node image.

NPM ?= npm
IMAGE ?= web-app

.DEFAULT_GOAL := help
.PHONY: help setup dev run fmt fmt-check lint typecheck test cov audit build check gen gen-check \
        e2e e2e-install sbom docker docker-check docker-e2e clean

help: ## List the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

setup: ## Install the locked dependencies (and the git hook, if pre-commit is available)
	$(NPM) ci
	-pre-commit install

dev: ## Dev server on http://localhost:5173 with the built-in mock gateway (sign in as dev@example.com)
	$(NPM) run dev

run: build ## Serve the production build on http://localhost:4173 (the mock gateway answers /api)
	$(NPM) run preview

fmt: ## Format and apply safe lint fixes
	$(NPM) run fmt

fmt-check: ## Fail if anything is unformatted
	$(NPM) run fmt:check

lint: ## Biome lint (including accessibility rules)
	$(NPM) run lint

typecheck: ## tsc --noEmit over the app and the tooling
	$(NPM) run typecheck

test: ## Unit and component tests (Vitest, Testing Library, MSW)
	$(NPM) test

cov: ## Tests with the coverage gate (85% lines)
	$(NPM) run cov

audit: ## npm audit: fail on high or critical, with a reviewed, expiring allow-list
	$(NPM) run audit

build: ## Production build into dist/
	$(NPM) run build

gen: ## Regenerate the typed API client from openapi/openapi.json
	$(NPM) run gen

gen-check: ## Fail if the generated client or route tree is stale
	$(NPM) run gen:check

check: fmt-check lint typecheck gen-check cov audit build ## Everything CI runs, in order

e2e-install: ## Install the Playwright browser (once)
	$(NPM) run e2e:install

e2e: ## End-to-end tests in a real browser (E2E_BASE_URL=... to target a real stack)
	$(NPM) run e2e

sbom: ## CycloneDX SBOM of the locked dependencies -> sbom.cdx.json
	$(NPM) run sbom

docker: ## Build the production image
	docker build -t $(IMAGE) .

docker-check: ## All checks inside the pinned Node image (no local Node needed)
	docker compose --profile tools run --rm tools

docker-e2e: ## End-to-end tests inside the pinned Playwright image
	docker compose --profile e2e run --rm e2e

clean: ## Remove build output and caches
	rm -rf dist coverage playwright-report test-results node_modules/.cache
