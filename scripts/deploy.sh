#!/usr/bin/env bash
# Deploys g1t: every part, or the ones named, in the order they depend on
# each other. Each part's D1 migrations are applied before its code goes
# out, so new code never meets an old database.
#
#   scripts/deploy.sh                 # everything
#   scripts/deploy.sh billing web     # just these, still in order
#
# Uses your `wrangler login`. The repository's .env may hold a token for
# other tools; it is ignored here unless you set CLOUDFLARE_DEPLOY_TOKEN.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_DEPLOY_TOKEN:-}"

# Dependency order: what others bind to goes first.
ORDER=(
  services/events
  services/identity
  services/repos
  services/work
  services/projects
  services/billing
  services/integrations
  services/webhooks
  services/actions
  services/models
  services/deployments
  services/runner
  apps/api
  services/pages
  apps/web
  apps/sudo
  apps/docs
)

wanted() {
  [ $# -eq 0 ] && return 0
  local dir="$1"; shift
  for name in "${PICK[@]}"; do
    [ "$dir" = "$name" ] || [ "$(basename "$dir")" = "$name" ] && return 0
  done
  return 1
}

PICK=("$@")
for dir in "${ORDER[@]}"; do
  [ ${#PICK[@]} -eq 0 ] || wanted "$dir" || continue
  echo "== $dir"
  cd "$ROOT/$dir"
  db=$(grep -o '"database_name": *"[^"]*"' wrangler.jsonc 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)
  if [ -n "$db" ] && [ -d migrations ]; then
    npx wrangler d1 migrations apply "$db" --remote
  fi
  if grep -q '"deploy": "[^"]*build' package.json 2>/dev/null; then
    npm run deploy
  else
    npx wrangler deploy
  fi
done
echo "== Deployed."
