#!/usr/bin/env bash
# Starts the status page of a self-hosted g1t (apps/status) in a workerd of
# its own on :8788, so it stays up when the site does not. Its database
# lives on its own volume. `wrangler dev` runs no crons, so a loop here
# asks for a round of checks every minute instead.
set -euo pipefail

cd "$(dirname "$0")"
DATA="${G1T_DATA:-/data}"
STATE="$DATA/state"
GENERATED="$DATA/generated"
WRANGLER="$(cd ../.. && pwd)/node_modules/.bin/wrangler"
mkdir -p "$STATE"

# configs.mjs writes every config; only the status page's is used here.
# It needs nothing secret, so placeholders stand in for the site's keys.
GITSTORE_SECRET="${GITSTORE_SECRET:-unused}" node configs.mjs "$GENERATED" >/dev/null
cd "$GENERATED"

echo "Migrating g1t-status"
"$WRANGLER" d1 migrations apply g1t-status --local --persist-to "$STATE" -c g1t-status.json >/dev/null

# Every minute, the cron's work: check each part and keep the result.
# (The image has Node but no curl.)
node -e '
const tick = () => fetch("http://127.0.0.1:8788/__scheduled?cron=*+*+*+*+*").catch(() => {});
setTimeout(() => { tick(); setInterval(tick, 60_000); }, 15_000);
' &

echo "The status page is starting on http://localhost:${STATUS_PORT:-8788}"
exec "$WRANGLER" dev -c g1t-status.json \
  --ip 0.0.0.0 --port 8788 \
  --persist-to "$STATE" \
  --test-scheduled \
  --show-interactive-dev-session=false
