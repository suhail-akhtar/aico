# The same verbs in every AICO starter: setup dev fmt lint test cov audit build check run.
# Requires GNU make; on Windows without make, run the underlying command shown on each line
# (every target is a one-line wrapper around ./mvnw or docker).
.DEFAULT_GOAL := help
MVN := ./mvnw
OSV_IMAGE := ghcr.io/google/osv-scanner:v2.6.0@sha256:afd838850ac1a0fcc15ff4a041dc9ba11123c3f0d2666217a5f0fcf9222b55fa

.PHONY: help setup dev db fmt lint test cov audit build smoke check run down

help: ## list the targets
	@grep -E '^[a-z]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/\t/'

setup: ## create .env.local with generated secrets and warm the Maven cache
	@test -f .env.local || { cp .env.example .env.local; \
	  for key in $$(grep -E '^[A-Z_]+=change-me' .env.local | cut -d= -f1); do \
	    secret=$$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n'); \
	    sed -i.bak "s|^$$key=change-me.*|$$key=$$secret|" .env.local; \
	  done; rm -f .env.local.bak; echo "wrote .env.local"; }
	$(MVN) -DskipTests -Dspotless.check.skip=true test-compile

dev: ## run the app with a throwaway database and a demo user (see DevApplication)
	$(MVN) spring-boot:test-run -Dspring-boot.run.main-class=com.example.app.DevApplication

db: ## start only PostgreSQL from compose (for running the app from an IDE)
	docker compose --env-file .env.local up -d --wait db

fmt: ## apply google-java-format
	$(MVN) spotless:apply

lint: ## format check, Error Prone + NullAway, SpotBugs + FindSecBugs, enforcer rules
	$(MVN) -DskipTests -Djacoco.skip=true verify

test: ## unit and architecture tests (fast, no database)
	$(MVN) test

cov: ## everything in verify: unit + integration tests, 85% line coverage gate (report in target/site/jacoco)
	$(MVN) verify

audit: ## dependency vulnerabilities from the SBOM (needs Docker); fails on any finding
	$(MVN) -q -DskipTests -Dspotless.check.skip=true process-resources
	docker run --rm -v "$(CURDIR):/src:ro" -w /src $(OSV_IMAGE) scan source \
	  --config osv-scanner.toml -L target/classes/META-INF/sbom/application.cdx.json

build: ## the production image
	docker build -t api-service:local .

smoke: ## build the image, start it with PostgreSQL and walk the API from outside (needs Docker, ~3 min)
	node scripts/smoke.mjs

check: cov audit smoke ## everything CI runs: format + lint + tests + coverage + audit + container smoke

run: ## the production image plus PostgreSQL, from compose
	@test -f .env.local || $(MAKE) setup
	docker compose --env-file .env.local up --build

down: ## stop the compose stack (data volume is kept)
	docker compose --env-file .env.local down
