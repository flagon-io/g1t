#!/usr/bin/env bash
# Deploys g1t: every part, or the ones named, migrations first and then
# stage by stage, as deploy/stack.jsonc orders them. A thin wrapper over
# scripts/deploy.mjs, which can also deploy only what changed:
#
#   scripts/deploy.sh                 # everything
#   scripts/deploy.sh billing web     # just these, still in order
#   node scripts/deploy.mjs plan      # what changed since each part's live commit
#   node scripts/deploy.mjs deploy    # only that
#
# Uses your `wrangler login`. The repository's .env may hold a token for
# other tools; it is ignored here unless you set CLOUDFLARE_DEPLOY_TOKEN.
# See docs/DEPLOYING.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ $# -eq 0 ]; then
  exec node "$ROOT/scripts/deploy.mjs" deploy --all
fi
names=$(IFS=,; echo "$*")
exec node "$ROOT/scripts/deploy.mjs" deploy --force --only "$names"
