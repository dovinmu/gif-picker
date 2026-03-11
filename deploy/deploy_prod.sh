#!/usr/bin/env bash
# Deploy frontend to production (honeycomb VM)
# Usage: ./deploy/deploy_prod.sh

set -euo pipefail

VM=honeycomb
ZONE=us-west1-c

echo "=== Deploying to $VM ($ZONE) ==="

echo "→ Pulling latest code on VM..."
gcloud compute ssh "$VM" --zone="$ZONE" --command="cd ~/gif-picker && git pull"

echo "→ Building frontend..."
gcloud compute ssh "$VM" --zone="$ZONE" --command="cd ~/gif-picker/web && pnpm install --frozen-lockfile && pnpm build"

echo "→ Deploying to /var/www/honeycomb/..."
gcloud compute ssh "$VM" --zone="$ZONE" --command="sudo cp -r ~/gif-picker/web/dist/* /var/www/honeycomb/"

echo "→ Verifying..."
gcloud compute ssh "$VM" --zone="$ZONE" --command="
  systemctl is-active antfly && echo 'antfly: OK' || echo 'antfly: DOWN'
  curl -sf -o /dev/null http://localhost:8080/api/v1/tables && echo 'api:    OK' || echo 'api:    FAIL'
"

echo "=== Deploy complete ==="
