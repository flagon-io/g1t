#!/usr/bin/env bash
# Sets up what Deployments needs on a Cloudflare account, once. Safe to run
# again: each step skips what exists. Then deploy with scripts/deploy.sh.
#
# Needs the Workers for Platforms add-on on the account, and a zone for
# apps (g1t uses g1t.page) named in services/pages/wrangler.jsonc.
#
# Two steps need more than `wrangler login` can do: a wildcard DNS record
# on the apps' zone, and an API token for the deployments service. Set
# CLOUDFLARE_EMAIL and CLOUDFLARE_API_KEY (a Global API Key) and this
# script makes both; otherwise it says what to make by hand.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_DEPLOY_TOKEN:-}"
ZONE="${G1T_APPS_ZONE:-g1t.page}"
NAMESPACE="g1t-deployments"
TOKEN_FILE="$ROOT/.credentials/deployments-cloudflare-token.txt"
w() { npx wrangler "$@"; }

cd "$ROOT/services/deployments"

echo "== D1 database"
if grep -q TO_BE_CREATED wrangler.jsonc; then
  id=$(w d1 create g1t-deployments </dev/null 2>&1 | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)
  [ -n "$id" ] || { echo "Could not create the database; is it there already? (npx wrangler d1 list)"; exit 1; }
  sed -i "s/TO_BE_CREATED/$id/" wrangler.jsonc
  echo "Created $id and wrote it into services/deployments/wrangler.jsonc. Commit that."
else
  echo "Already set."
fi

echo "== Dispatch namespace and event queue"
w dispatch-namespace list 2>/dev/null | grep -q "$NAMESPACE" || w dispatch-namespace create "$NAMESPACE"
w queues list 2>/dev/null | grep -q g1t-events-deployments || w queues create g1t-events-deployments

echo "== DNS record and the service's token"
if [ -n "${CLOUDFLARE_API_KEY:-}" ] && [ -n "${CLOUDFLARE_EMAIL:-}" ]; then
  G1T_APPS_ZONE="$ZONE" TOKEN_FILE="$TOKEN_FILE" python "$ROOT/scripts/cloudflare-setup.py"
else
  cat <<EOF
Set CLOUDFLARE_EMAIL and CLOUDFLARE_API_KEY to do this for you, or by hand:
  1. On $ZONE, add a proxied DNS record: type AAAA, name *, content 100::
  2. Create an API token with Workers Scripts: Edit and Account Analytics:
     Read on the account, and save it as one line in
     $TOKEN_FILE
EOF
fi

if [ -f "$TOKEN_FILE" ]; then
  echo "== Storing the token as the deployments service's secret"
  w deploy
  tr -d '\r\n' <"$TOKEN_FILE" | w secret put CLOUDFLARE_API_TOKEN
fi
echo "== Done. Now: scripts/deploy.sh"
