#!/bin/sh
# Dependency audit: govulncheck, with a reviewed allow-list.
#
# govulncheck reports only vulnerabilities whose vulnerable code your program can
# actually reach, so a finding here is real. It exits non-zero on any finding;
# this wrapper lets a person accept a specific one by adding a line to
# .audit-allowlist ("GO-2026-1234  reason  review-by YYYY-MM-DD"), and still
# fails on every other finding. An exception past its review date fails too, so
# an accepted risk cannot be forgotten.
#
# GOVULNCHECK is the command to run (the Makefile sets it).
set -u

GOVULNCHECK=${GOVULNCHECK:-govulncheck}
ALLOWLIST=${ALLOWLIST:-.audit-allowlist}
TODAY=$(date -u +%Y-%m-%d)

if [ -f "$ALLOWLIST" ]; then
  # Fail on expired exceptions before looking at findings.
  expired=0
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    id=${line%% *}
    until=$(printf '%s\n' "$line" | sed -n 's/.*review-by \([0-9-]\{10\}\).*/\1/p')
    if [ -z "$until" ]; then
      echo "audit: $id in $ALLOWLIST has no 'review-by YYYY-MM-DD'" >&2
      expired=1
    elif [ "$until" \< "$TODAY" ]; then
      echo "audit: the exception for $id expired on $until; re-review it or fix the dependency" >&2
      expired=1
    fi
  done < "$ALLOWLIST"
  [ "$expired" -eq 0 ] || exit 1
fi

out=$($GOVULNCHECK ./... 2>&1)
status=$?
printf '%s\n' "$out"
[ "$status" -eq 0 ] && exit 0

ids=$(printf '%s\n' "$out" | grep -o 'GO-[0-9]\{4\}-[0-9]\{4,\}' | sort -u)
if [ -z "$ids" ]; then
  echo "audit: govulncheck failed (exit $status) without naming a vulnerability" >&2
  exit "$status"
fi
bad=0
for id in $ids; do
  if [ -f "$ALLOWLIST" ] && grep -q "^$id[[:space:]]" "$ALLOWLIST"; then
    echo "audit: $id is accepted in $ALLOWLIST"
  else
    echo "audit: $id is not in $ALLOWLIST" >&2
    bad=1
  fi
done
exit "$bad"
