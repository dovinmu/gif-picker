#!/usr/bin/env bash
# Deploy the Honeycomb application and frontend together to an existing VM.
# Usage: ./deploy/deploy.sh [dev|prod]
# Node 24, pnpm 10.11.0 and an installed/enabled honeycomb.service are manual
# prerequisites. This script never installs units, packages or infrastructure.

set -euo pipefail

TARGET="${1:?Usage: deploy.sh [dev|prod]}"
ZONE=us-west1-c

case "$TARGET" in
  dev)
    VM=honeycomb-dev
    ;;
  prod)
    VM=honeycomb
    ;;
  *)
    echo "Unknown target: $TARGET (expected dev or prod)" >&2
    exit 1
    ;;
esac

echo "=== Deploying to $VM ($TARGET, $ZONE) ==="

echo "Checking prerequisites before changing the VM..."
gcloud compute ssh "$VM" --zone="$ZONE" --command='
  set -euo pipefail
  export PATH="/usr/bin:$PATH"
  if [ ! -x /usr/bin/node ]; then
    echo "Install Node 24 at /usr/bin/node before deploying." >&2
    exit 1
  fi
  case "$(/usr/bin/node --version)" in
    v24.*) ;;
    *) echo "Node 24 is required at /usr/bin/node." >&2; exit 1 ;;
  esac
  if [ "$(systemctl show honeycomb.service --property=LoadState --value)" != loaded ] ||
     ! systemctl is-enabled --quiet honeycomb.service; then
    echo "Manually install and enable deploy/honeycomb.service before deploying." >&2
    exit 1
  fi
  if ! command -v pnpm >/dev/null || [ "$(pnpm --version)" != 10.11.0 ]; then
    echo "Install pnpm 10.11.0 before deploying." >&2
    exit 1
  fi
  command -v curl >/dev/null
  test -d /home/rowan/gif-picker/.git
'

echo "Pulling and building the application..."
gcloud compute ssh "$VM" --zone="$ZONE" --command='
  set -euo pipefail
  export PATH="/usr/bin:$PATH"
  cd /home/rowan/gif-picker
  git pull --ff-only
  cd web
  pnpm install --frozen-lockfile
  pnpm server:typecheck
  pnpm build
'

echo "Restarting and verifying the application..."
gcloud compute ssh "$VM" --zone="$ZONE" --command='
  set -euo pipefail
  sudo systemctl restart honeycomb.service
  systemctl is-active --quiet honeycomb.service
  curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 \
    http://localhost:8090/healthz |
    /usr/bin/node --input-type=module -e '\''
      let body = "";
      for await (const chunk of process.stdin) body += chunk;
      if (JSON.parse(body).ok !== true) process.exit(1);
    '\''
  curl --fail --silent --show-error \
    -H "Content-Type: application/json" \
    --data '\''{"query":"cat","limit":1}'\'' \
    http://localhost:8090/api/search |
    /usr/bin/node --input-type=module -e '\''
      let body = "";
      for await (const chunk of process.stdin) body += chunk;
      const result = JSON.parse(body);
      if (!Array.isArray(result.results) || typeof result.total !== "number") process.exit(1);
    '\''
'

echo "=== Deploy to $TARGET complete ==="
