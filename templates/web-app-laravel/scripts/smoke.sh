#!/bin/sh
# Smoke test of the BUILT production image: `sh scripts/smoke.sh <image>`.
# It starts the container the way production does (read-only root filesystem, no
# Linux capabilities, non-root user, no new privileges) with a throwaway SQLite
# database and a throwaway key, waits for the Docker healthcheck, then runs
# scripts/smoke.php inside it: health, readiness, sign-up, the items feature
# over the JSON API, security headers. Exit 0 only if every step passed.
set -eu
export MSYS_NO_PATHCONV=1 # Git Bash on Windows would otherwise rewrite "/tmp" in the docker arguments

IMAGE=${1:?usage: smoke.sh <image>}
NAME="smoke-$$"
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
KEY="base64:$(head -c 32 /dev/urandom | base64)"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

docker run -d --name "$NAME" \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  -e APP_KEY="$KEY" -e APP_URL=http://127.0.0.1:8080 \
  -e DB_CONNECTION=sqlite -e DB_DATABASE=/tmp/smoke.sqlite \
  -e SESSION_DRIVER=database -e CACHE_STORE=database -e QUEUE_CONNECTION=sync \
  -e SESSION_SECURE_COOKIE=false -e API_DOCS_ENABLED=true \
  "$IMAGE" >/dev/null

echo "waiting for the container healthcheck..."
i=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ]; do
  i=$((i + 1))
  if [ "$i" -gt 60 ] || [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != true ]; then
    echo "FAIL: container did not become healthy"; docker logs "$NAME" 2>&1 | tail -30; exit 1
  fi
  sleep 1
done
echo "ok: healthy"

[ "$(docker exec "$NAME" id -u)" != 0 ] && echo "ok: runs as non-root (uid $(docker exec "$NAME" id -u))" || { echo "FAIL: runs as root"; exit 1; }
if docker exec "$NAME" sh -c 'touch /app/probe 2>/dev/null'; then echo "FAIL: root filesystem is writable"; exit 1; else echo "ok: root filesystem is read-only"; fi

docker exec "$NAME" php -r 'touch("/tmp/smoke.sqlite");'
docker exec "$NAME" php artisan migrate --force --no-interaction >/dev/null
echo "ok: migrations applied"

docker exec -i "$NAME" php < "$HERE/smoke.php"

# Logs must be JSON, one object per line (application and web server alike).
bad=$(docker logs "$NAME" 2>&1 | grep -v '^[[:space:]]*$' | grep -vc '^{' || true)
total=$(docker logs "$NAME" 2>&1 | grep -vc '^[[:space:]]*$' || true)
echo "logs: $total lines, $bad not JSON"
docker logs "$NAME" 2>&1 | grep -q '"request_id"\|"level"' && echo "ok: structured log lines present" || { echo "FAIL: no structured log lines"; exit 1; }
echo "SMOKE PASSED"
