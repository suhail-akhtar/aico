# The same verbs in every AICO starter: setup dev fmt lint test cov audit build check run.
# `make` is a convenience: every target is one or two plain `dotnet` commands, so on a machine
# without make (Windows) copy the command. CI runs these same targets.

SLN      := ApiService.slnx
APP      := src/ApiService/ApiService.csproj
COVERAGE := artifacts/coverage

.DEFAULT_GOAL := help
.PHONY: help setup dev fmt fmt-check lint typecheck test test-pg cov audit sbom build check run up down migration migrate clean

help: ## List the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

setup: ## Restore local tools and packages (locked) and print the next step
	dotnet tool restore
	dotnet restore $(SLN)
	@echo "Next: cp .env.example .env, then make dev"

dev: ## Run on SQLite in Development (no database server needed) at http://127.0.0.1:5080
	dotnet run --project $(APP) --launch-profile Development

fmt: ## Rewrite files to the repository style
	dotnet format $(SLN)

fmt-check: ## Fail if any file is not formatted (whitespace, style, analyzers)
	dotnet format $(SLN) --verify-no-changes

lint: ## Fail on style or analyzer findings at warning level or above
	dotnet format style $(SLN) --verify-no-changes --severity warn
	dotnet format analyzers $(SLN) --verify-no-changes --severity warn

typecheck: ## Compile with every warning an error (analyzers included)
	dotnet build $(SLN) -warnaserror --nologo

test: ## Unit, integration, contract, architecture and security tests (SQLite in memory, no Docker)
	dotnet test --solution $(SLN)

test-pg: ## The same suite against a real PostgreSQL in a throwaway container (needs Docker)
	TEST_POSTGRES=1 dotnet test --solution $(SLN)

cov: ## Tests with coverage; fails under 85 % of lines; writes artifacts/coverage/report
	dotnet test --solution $(SLN) --results-directory $(COVERAGE) --coverlet \
		--coverlet-include "[ApiService]*" --coverlet-exclude-by-file "**/Migrations/**/*.cs" \
		--coverlet-output-format cobertura \
		--coverlet-threshold 85 --coverlet-threshold-type line --coverlet-threshold-stat total
	dotnet tool run reportgenerator -reports:"$(COVERAGE)/*.xml" -targetdir:$(COVERAGE)/report -reporttypes:"TextSummary;Html;MarkdownSummaryGithub"
	@cat $(COVERAGE)/report/Summary.txt

audit: ## Fail on a high or critical advisory (direct or transitive); list deprecated packages
	dotnet restore $(SLN) --force --verbosity quiet
	dotnet list $(SLN) package --vulnerable --include-transitive
	dotnet list $(SLN) package --deprecated

sbom: ## CycloneDX software bill of materials of what ships -> artifacts/sbom/bom.json
	dotnet tool run dotnet-cyclonedx $(APP) -o artifacts/sbom -F Json

build: ## Publish the release build to artifacts/publish
	dotnet publish $(APP) -c Release -o artifacts/publish

check: fmt-check lint typecheck cov audit ## Everything CI runs, in order

run: ## Run the Release build
	dotnet run --project $(APP) -c Release --launch-profile Development

up: ## PostgreSQL + migration job + API in containers (needs .env)
	docker compose up --build -d

down: ## Stop the containers (keeps the database volume)
	docker compose down

migration: ## New EF migration: make migration name=AddOrders
	@test -n "$(name)" || (echo "usage: make migration name=<WhatChanged>" && exit 2)
	dotnet tool run dotnet-ef migrations add $(name) --project $(APP) --output-dir Persistence/Migrations

migrate: ## Apply migrations to the database in ConnectionStrings__Default (Postgres)
	Database__Provider=Postgres dotnet run --project $(APP) -c Release --no-launch-profile -- --migrate

clean: ## Remove build output
	rm -rf artifacts src/ApiService/data
