#!/bin/sh
# Container entrypoint. Fails fast on bad configuration, then warms the framework
# caches into /tmp (the root filesystem is read-only) and hands over to the command.
# Why not bake the caches at build time: config:cache freezes env() at that moment,
# and secrets only exist at runtime.
# Output stays silent on success so every line a container writes is a JSON log line.
set -eu

mkdir -p /tmp/bootstrap/views /tmp/caddy/config /tmp/caddy/data

if ! php artisan app:check-config >/tmp/check-config.log 2>&1; then
  cat /tmp/check-config.log >&2
  exit 1
fi
php artisan optimize --quiet

exec "$@"
