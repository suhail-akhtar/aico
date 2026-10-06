#!/bin/sh
# Smoke test of the built stack: PostgreSQL + migrations + the API, through HTTP.
# Needs docker compose and curl. Generates throwaway secrets; deletes the stack after.
set -eu

# Random high ports unless given, so a PostgreSQL or API already running on this machine cannot collide.
rand_port() { echo $((20000 + $(od -An -N2 -tu2 /dev/urandom | tr -d " ") % 20000)); }
PORT=${PORT:-$(rand_port)}
DB_PORT=${DB_PORT:-$(rand_port)}
export PORT DB_PORT
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')}
export POSTGRES_PASSWORD
BASE="http://127.0.0.1:$PORT"

cleanup() { docker compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker compose up -d --build --wait --wait-timeout 180 db api

curl --fail --silent --show-error "$BASE/healthz" | grep -q '"ok"'
curl --fail --silent --show-error "$BASE/readyz" | grep -q '"ok"'
curl --fail --silent --show-error "$BASE/openapi.yaml" | grep -q 'openapi: 3'

creds='{"email":"smoke@example.com","password":"smoke-test-password-123"}'
json='Content-Type: application/json'
curl --fail --silent --show-error -X POST -H "$json" -d "$creds" "$BASE/v1/auth/register" >/dev/null
token=$(curl --fail --silent --show-error -X POST -H "$json" -d "$creds" "$BASE/v1/auth/login" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
[ -n "$token" ] || { echo "smoke: login returned no token" >&2; exit 1; }

curl --fail --silent --show-error -X POST -H "Authorization: Bearer $token" -H "$json" \
  -d '{"name":"smoke item","quantity":1}' "$BASE/v1/items" | grep -q '"smoke item"'
curl --fail --silent --show-error -H "Authorization: Bearer $token" "$BASE/v1/items" | grep -q '"smoke item"'

# Unauthenticated access must be refused.
code=$(curl --silent --output /dev/null --write-out '%{http_code}' "$BASE/v1/items")
[ "$code" = "401" ] || { echo "smoke: unauthenticated GET /v1/items answered $code, want 401" >&2; exit 1; }

echo "smoke: ok"
