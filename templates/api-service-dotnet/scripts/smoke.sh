#!/bin/sh
# Smoke test of a running instance (the container, or `make dev`): sh scripts/smoke.sh http://127.0.0.1:8080
# Needs only curl. It checks what a deploy must prove: probes, an authenticated round trip through the database,
# the 401/400/413 error shapes, token rotation, and the security headers. Exit code 0 means every check passed.
set -eu

BASE="${1:-http://127.0.0.1:8080}"
FAILS=0
EMAIL="smoke-$(date +%s)-$$@example.test"
PASSWORD="a long smoke test password"

ok()   { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; FAILS=$((FAILS + 1)); }
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# Wait for readiness (the migration job may still be finishing).
i=0
until [ "$(status "$BASE/readyz" || true)" = "200" ]; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then echo "readyz did not answer 200 within 60 s"; exit 1; fi
  sleep 1
done

[ "$(status "$BASE/healthz")" = "200" ] && ok "/healthz 200" || fail "/healthz"
[ "$(curl -s "$BASE/readyz")" = '{"status":"ok"}' ] && ok "/readyz body is the status word only" || fail "/readyz body"

headers=$(curl -s -D - -o /dev/null "$BASE/healthz")
for h in "X-Content-Type-Options: nosniff" "X-Frame-Options: DENY" "Content-Security-Policy: default-src 'none'" "Referrer-Policy: no-referrer"; do
  if printf '%s' "$headers" | grep -qi "^$h"; then ok "header $h"; else fail "header $h"; fi
done
if printf '%s' "$headers" | grep -qi '^server:'; then fail "no Server header"; else ok "no Server header"; fi

[ "$(status "$BASE/items")" = "401" ] && ok "/items without a token is 401" || fail "/items unauthenticated"

reg=$(curl -s -X POST "$BASE/auth/register" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
token=$(printf '%s' "$reg" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
refresh=$(printf '%s' "$reg" | sed -n 's/.*"refresh_token":"\([^"]*\)".*/\1/p')
if [ -n "$token" ]; then ok "register returns tokens"; else fail "register"; echo "$reg"; fi

if [ -n "$token" ]; then
  created=$(curl -s -X POST "$BASE/items" -H "authorization: Bearer $token" -H 'content-type: application/json' -d '{"name":"smoke item","quantity":2}')
  id=$(printf '%s' "$created" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
  if [ -n "$id" ]; then ok "item created in the database"; else fail "create item"; echo "$created"; fi
  [ "$(status "$BASE/items/$id" -H "authorization: Bearer $token")" = "200" ] && ok "item read back" || fail "read item"
  [ "$(curl -s "$BASE/items?limit=1" -H "authorization: Bearer $token" | grep -c '"next_cursor"')" = "1" ] && ok "list answers items and next_cursor (snake_case contract)" || fail "list shape"
  [ "$(status -X POST "$BASE/items" -H "authorization: Bearer $token" -H 'content-type: application/json' -d '{"name":""}')" = "400" ] && ok "empty name is 400" || fail "validation 400"

  big=$(mktemp)
  # Valid JSON, 2 MiB long: the parser must reach the limit, not fail on the first byte.
  { printf '{"name":"'; head -c 2097152 /dev/zero | tr '\0' 'a'; printf '"}'; } > "$big"
  [ "$(status -X POST "$BASE/items" -H "authorization: Bearer $token" -H 'content-type: application/json' --data-binary "@$big")" = "413" ] && ok "2 MiB body is 413" || fail "body limit"
  # Chunked upload has no Content-Length, so only the server's own limit can stop it.
  [ "$(status -X POST "$BASE/items" -H "authorization: Bearer $token" -H 'content-type: application/json' -H 'Transfer-Encoding: chunked' --data-binary "@$big")" = "413" ] && ok "chunked 2 MiB body is 413" || fail "chunked body limit"
  rm -f "$big"

  rot=$(curl -s -X POST "$BASE/auth/refresh" -H 'content-type: application/json' -d "{\"refresh_token\":\"$refresh\"}")
  if printf '%s' "$rot" | grep -q '"access_token"'; then ok "refresh rotates"; else fail "refresh"; fi
  [ "$(status -X POST "$BASE/auth/refresh" -H 'content-type: application/json' -d "{\"refresh_token\":\"$refresh\"}")" = "401" ] && ok "replayed refresh token is 401" || fail "refresh replay"
fi

[ "$(status "$BASE/openapi/v1.json")" = "200" ] && ok "OpenAPI document served" || fail "openapi"

if [ "$FAILS" -ne 0 ]; then echo "smoke: $FAILS check(s) failed"; exit 1; fi
echo "smoke: all checks passed"
