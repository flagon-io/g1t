#!/usr/bin/env bash
# Starts self-hosted g1t inside its container: makes the keys it needs once,
# writes the Wrangler configs, brings every database up to date, and runs
# every Worker in one workerd on :8787.
set -euo pipefail

cd "$(dirname "$0")"
HERE="$(pwd)"
DATA="${G1T_DATA:-/data}"
STATE="$DATA/state"
KEYS="$DATA/keys.env"
GENERATED="$DATA/generated"
WRANGLER="$(cd ../.. && pwd)/node_modules/.bin/wrangler"
mkdir -p "$STATE"

# Keys that seal secrets at rest (actions, integrations, webhooks). Made on
# first start and kept on the volume: losing them loses those secrets.
if [ ! -f "$KEYS" ]; then
  umask 077
  {
    echo "ACTIONS_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
    echo "INTEGRATIONS_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
    echo "WEBHOOKS_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  } > "$KEYS"
fi
# Identity's key seals the GitHub tokens of linked accounts; added to keys
# made before it existed.
if ! grep -q '^IDENTITY_KEY=' "$KEYS"; then
  echo "IDENTITY_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" >> "$KEYS"
fi
# The packages service's key, which signs registry tokens.
if ! grep -q '^PACKAGES_TOKEN_SECRET=' "$KEYS"; then
  echo "PACKAGES_TOKEN_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" >> "$KEYS"
fi
set -a
# shellcheck disable=SC1090
. "$KEYS"
set +a

# The git store's shared secret: given, or the file the git store made.
if [ -z "${GITSTORE_SECRET:-}" ] && [ -n "${GITSTORE_SECRET_FILE:-}" ]; then
  for _ in $(seq 1 60); do [ -s "$GITSTORE_SECRET_FILE" ] && break; sleep 1; done
  GITSTORE_SECRET="$(cat "$GITSTORE_SECRET_FILE")"
  export GITSTORE_SECRET
fi
[ -n "${GITSTORE_SECRET:-}" ] || { echo "No GITSTORE_SECRET or GITSTORE_SECRET_FILE." >&2; exit 1; }

node configs.mjs "$GENERATED"
cd "$GENERATED"

# Migrations: the same files D1 gets, applied to the SQLite files on the
# volume. Applied ones are recorded, so this is safe on every start.
for config in $(cat workers.txt); do
  for database in $(node -e "for (const d of require('./$config').d1_databases ?? []) console.log(d.database_name)"); do
    echo "Migrating $database"
    "$WRANGLER" d1 migrations apply "$database" --local --persist-to "$STATE" -c "$config" >/dev/null
  done
done

args=()
while read -r config; do args+=(-c "$config"); done < workers.txt

# workerd fires no cron triggers: the scheduler runs the services' crons
# (schedules.json, from configs.mjs) once a minute through Wrangler's local
# API, which answers only here, on localhost.
node "$HERE/scheduler.mjs" schedules.json http://127.0.0.1:8787 &
echo "g1t is starting on ${PUBLIC_URL:-http://localhost:8787}"
exec "$WRANGLER" dev "${args[@]}" \
  --ip 0.0.0.0 --port 8787 \
  --persist-to "$STATE" \
  --show-interactive-dev-session=false
