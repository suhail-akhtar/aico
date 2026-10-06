# Same verbs in every AICO starter: setup dev fmt lint test cov audit build check run.
# Everything PHP runs inside the `tools` container, so no PHP or Composer is needed on
# the host (only Docker). With PHP 8.5 + Composer installed natively: make RUN= check

RUN ?= docker compose run --rm tools
DEV = docker compose -f compose.yaml -f compose.dev.yaml
IMAGE ?= __APP_SLUG__

.DEFAULT_GOAL := help
.PHONY: help setup dev fmt lint test cov audit sbom openapi build check run down logs shell smoke

help: ## List the verbs
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-9s %s\n", $$1, $$2}'

setup: ## Build the tools image, install dependencies, create .env with an APP_KEY
	docker compose build tools
	@test -f .env || cp .env.example .env
	$(RUN) composer install --no-interaction --prefer-dist
	@grep -q '^APP_KEY=base64:' .env || $(RUN) php artisan key:generate --ansi

dev: ## Run the stack with live reload (app :8080, Vite :5173, Mailpit :8025)
	$(DEV) up --build

fmt: ## Format the code (Pint)
	$(RUN) composer fmt

lint: ## Format check (Pint) + static analysis (PHPStan level 10 via Larastan)
	$(RUN) composer lint
	$(RUN) composer analyse

test: ## Run the tests
	$(RUN) composer test

cov: ## Tests with coverage; fails under 85%
	$(RUN) composer cov

audit: ## Fail on known-vulnerable dependencies
	$(RUN) composer audit --locked

sbom: ## Write a CycloneDX SBOM to sbom.cdx.json
	$(RUN) composer sbom

openapi: ## Regenerate docs/openapi.json after an API change
	$(RUN) composer openapi

build: ## Build the production image
	docker build -t $(IMAGE) .

check: lint cov audit ## Everything CI runs (format, analysis, tests+coverage, audit)

run: ## Run the production-like stack (built image, read-only, non-root)
	docker compose up --build

down: ## Stop the stack (add -v to delete the database volume)
	docker compose -f compose.yaml -f compose.dev.yaml down --remove-orphans

logs: ## Follow the application logs (JSON, one object per line)
	docker compose logs -f app queue scheduler

shell: ## A shell in the tools container
	$(RUN) sh

smoke: build ## Start the built image and check /healthz
	sh scripts/smoke.sh $(IMAGE)
