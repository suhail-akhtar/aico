# The same verbs in every AICO starter: setup dev fmt lint test cov audit build check run.
# Requires GNU make; without it, run the command shown on each line (every target wraps one command).
.DEFAULT_GOAL := help
API := services/api
WEB := services/web

.PHONY: help setup dev fmt lint test cov audit build check run down

help: ## list the targets
	@grep -E '^[a-z]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/\t/'

setup: ## create .env with random secrets, install web dependencies
	@test -f .env || { cp .env.example .env; \
	  for key in $$(grep -E '^[A-Z_]+=change-me' .env | cut -d= -f1); do \
	    secret=$$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n'); \
	    sed -i.bak "s|^$$key=change-me.*|$$key=$$secret|" .env; \
	  done; rm -f .env.bak; echo "wrote .env"; }
	npm --prefix $(WEB) ci

dev: ## the whole system in containers (app on http://localhost:8080, mail on :8025)
	@test -f .env || $(MAKE) setup
	docker compose up --build --wait

fmt: ## apply google-java-format and biome
	cd $(API) && ./mvnw spotless:apply
	npm --prefix $(WEB) run fmt

lint: ## format check + Error Prone/NullAway/SpotBugs (api), biome + tsc (web)
	cd $(API) && ./mvnw -DskipTests -Djacoco.skip=true verify
	npm --prefix $(WEB) run fmt:check
	npm --prefix $(WEB) run lint
	npm --prefix $(WEB) run typecheck

test: ## fast unit and architecture tests (api), vitest (web)
	cd $(API) && ./mvnw test
	npm --prefix $(WEB) test

cov: ## everything in verify (integration tests on PostgreSQL + Valkey, 85% gate) + web coverage
	cd $(API) && ./mvnw verify
	npm --prefix $(WEB) run cov

audit: ## dependency vulnerabilities: OSV-Scanner on the API's SBOM (needs Docker), npm audit
	cd $(API) && node scripts/audit.mjs
	npm --prefix $(WEB) run audit

build: ## the production images
	docker compose build

check: lint cov audit build ## what CI runs

run: dev ## alias of dev

down: ## stop the stack (add -v by hand to also delete the data volumes)
	docker compose down
