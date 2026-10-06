# The same verbs in every AICO starter. `make help` lists them.
# No `make` (Windows)? Each target is one `uv run ...` line: run it directly.

UV ?= uv
IMAGE ?= api-service

.DEFAULT_GOAL := help
.PHONY: help setup dev run fmt fmt-check lint typecheck test cov test-pg audit build check \
        openapi migrate seed sbom clean

help: ## List the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

setup: ## Install the locked dependencies (and the git hook, if pre-commit is available)
	$(UV) sync --locked
	-$(UV) tool run pre-commit install

dev: ## Run with auto-reload on http://localhost:8000
	$(UV) run uvicorn app.main:create_app --factory --reload --port 8000 --no-server-header

run: ## Run like production (no reload), on 0.0.0.0:8000
	$(UV) run uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000 --proxy-headers --no-access-log --no-server-header

fmt: ## Format and apply safe lint fixes
	$(UV) run ruff format .
	$(UV) run ruff check --fix .

fmt-check: ## Fail if anything is unformatted
	$(UV) run ruff format --check .

lint: ## Ruff (incl. security rules) and Bandit
	$(UV) run ruff check .
	$(UV) run bandit -q -c pyproject.toml -r src

typecheck: ## mypy --strict
	$(UV) run mypy

test: ## Tests on SQLite (fast, no Docker)
	$(UV) run pytest -q

cov: ## Tests with the coverage gate (85%)
	$(UV) run pytest --cov --cov-report=term-missing

test-pg: ## The same suite against real PostgreSQL (needs Docker)
	docker compose --profile tools run --rm --build tools

audit: ## Dependency vulnerabilities (pip-audit over the lockfile, reviewed allow-list)
	$(UV) run python scripts/audit.py

build: ## Build the container image
	docker build -t $(IMAGE) .

check: fmt-check lint typecheck cov audit ## Everything CI runs, in order

openapi: ## Regenerate openapi.json (commit the result)
	$(UV) run python -m app.cli openapi

migrate: ## Apply database migrations to DATABASE_URL
	$(UV) run python -m app.cli migrate

seed: ## Create the development demo user (needs SEED_PASSWORD)
	$(UV) run python -m app.cli seed

sbom: ## CycloneDX SBOM of the locked runtime dependencies -> sbom.cdx.json
	$(UV) export --format cyclonedx1.5 --preview-features sbom-export --locked --no-dev --output-file sbom.cdx.json

clean: ## Remove caches and local data
	rm -rf .pytest_cache .mypy_cache .ruff_cache .hypothesis .coverage coverage.xml htmlcov data
