#!/bin/bash
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: $0 <gif_id> [gif_id ...]"
  exit 1
fi

ANTFLY_URL="${ANTFLY_URL:-http://localhost:8080/db/v1}"
TABLE="${TABLE:-honeycomb}"

# Build JSON array of IDs
deletes=$(printf '%s\n' "$@" | jq -R . | jq -s .)

auth=()
if [ -n "${ANTFLY_API_KEY:-}" ]; then
  auth=(-H "Authorization: Bearer ${ANTFLY_API_KEY}")
fi

curl -X POST "${ANTFLY_URL}/tables/${TABLE}/batch" \
  "${auth[@]}" \
  -H "Content-Type: application/json" \
  -d "{\"deletes\": ${deletes}}"
