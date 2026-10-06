#!/bin/sh
# Container entrypoint: write /tmp/runtime/config.json from the environment, then run nginx.
#
# Why a script and not envsubst: the values are interpolated into JSON that the browser trusts, so
# each one is checked against a strict pattern first. A value that does not match stops the
# container (exit 64) with a message, instead of serving a broken or hostile config.json.
# Every URL must be a path on this origin ("/api"), never another origin: the session cookie
# would be sent to it. /tmp is a tmpfs, so this works with a read-only root filesystem.
set -eu

API_BASE_URL="${API_BASE_URL:-/api}"
LOGIN_URL="${LOGIN_URL:-/api/auth/start}"
LOGOUT_URL="${LOGOUT_URL:-/api/auth/sign_out?rd=/}"
APP_ENVIRONMENT="${APP_ENVIRONMENT:-production}"

fail() {
  echo "entrypoint: $1" >&2
  exit 64
}

check_path() {
  # Starts with a single "/", then URL-safe characters only: no quote, backslash, space or control character.
  printf '%s' "$2" | grep -Eq "^/([^/][A-Za-z0-9._~!\$&()*+,;=:@%/?-]*)?\$" ||
    fail "$1 must be a path on this origin (for example /api); refusing to start"
}

check_path API_BASE_URL "$API_BASE_URL"
check_path LOGIN_URL "$LOGIN_URL"
check_path LOGOUT_URL "$LOGOUT_URL"
printf '%s' "$APP_ENVIRONMENT" | grep -Eq '^[A-Za-z0-9._-]{1,32}$' ||
  fail "APP_ENVIRONMENT must be 1 to 32 letters, digits, dots, dashes or underscores"

mkdir -p /tmp/runtime
printf '{"apiBaseUrl":"%s","loginUrl":"%s","logoutUrl":"%s","environment":"%s"}\n' \
  "$API_BASE_URL" "$LOGIN_URL" "$LOGOUT_URL" "$APP_ENVIRONMENT" >/tmp/runtime/config.json

exec nginx -g 'daemon off;'
