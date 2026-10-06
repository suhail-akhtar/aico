# The same verbs as every AICO starter. The services are complete projects with their own Makefiles
# (they need Node 24 and uv); the stack-level verbs below need only Docker.
.DEFAULT_GOAL := help
.PHONY: help setup dev run fmt lint test cov audit build check e2e down clean

help: ## List the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-8s %s\n", $$1, $$2}'

setup: ## Create .env from .env.example with random secrets (Linux/macOS/Git Bash)
	@test -f .env || (sed -E "s/=change-me.*/=PLACEHOLDER/" .env.example | while IFS= read -r l; do case "$$l" in *=PLACEHOLDER) echo "$${l%%=*}=$$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')";; *) echo "$$l";; esac; done > .env && echo "wrote .env")

dev: setup ## Build and start the whole stack on http://localhost:8080
	docker compose up --build --wait

run: dev ## Same as dev

fmt: ## Format both services
	$(MAKE) -C services/web fmt
	$(MAKE) -C services/api fmt

lint: ## Lint both services
	$(MAKE) -C services/web lint
	$(MAKE) -C services/api lint

test: ## Unit and component tests of both services
	$(MAKE) -C services/web test
	$(MAKE) -C services/api test

cov: ## Tests with the coverage gates
	$(MAKE) -C services/web cov
	$(MAKE) -C services/api cov

audit: ## Dependency audits of both services
	$(MAKE) -C services/web audit
	$(MAKE) -C services/api audit

build: ## Build both images
	docker compose build

check: ## Everything the services check, plus the stack e2e
	$(MAKE) -C services/web check
	$(MAKE) -C services/api check
	$(MAKE) e2e

e2e: setup ## Stack up, then Playwright through Traefik and Keycloak
	docker compose up --build --wait
	docker compose --profile e2e run --rm e2e

down: ## Stop the stack (keep volumes)
	docker compose down

clean: ## Stop the stack and delete its volumes
	docker compose --profile e2e down -v
