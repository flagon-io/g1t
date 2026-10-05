#!/usr/bin/env bash
# Sets up custom domains for deployed apps, once. Safe to run again: each
# step skips what exists. Run after scripts/setup-deployments.sh, then
# deploy with scripts/deploy.sh (deployments, then pages).
#
# Custom domains are Cloudflare for SaaS custom hostnames on the apps' zone
# (g1t.page). Turn Cloudflare for SaaS on for the zone first, in the
# dashboard: SSL/TLS, Custom Hostnames. Until then the API answers with
# codes 1404 or 1456, and g1t says custom domains are being switched on.
#
# This script:
#   1. creates the g1t-domains KV namespace (hostname -> app) and writes its
#      id into services/deployments and services/pages wrangler.jsonc;
#   2. adds the fallback origin's DNS record: domains.g1t.page, proxied
#      AAAA 100:: (what every custom domain points at);
#   3. sets domains.g1t.page as the zone's custom hostname fallback origin.
#
# Steps 2 and 3 need CLOUDFLARE_EMAIL and CLOUDFLARE_API_KEY (a Global API
# Key), or CLOUDFLARE_ZONE_TOKEN with DNS: Edit and SSL and Certificates:
# Edit on the zone; otherwise it says what to do by hand.
#
# The deployments service's own token (its CLOUDFLARE_API_TOKEN secret)
# also needs SSL and Certificates: Edit on the zone, to add custom
# hostnames. Add that permission to the token in the dashboard.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_DEPLOY_TOKEN:-}"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-1e6f2cffa3f445920836e8ebe446bb58}"
ZONE_ID="${G1T_APPS_ZONE_ID:-45d1c969bdd9d593756e70d5f45c2cbb}"
FALLBACK="${G1T_DOMAINS_FALLBACK:-domains.g1t.page}"
API="https://api.cloudflare.com/client/v4"
w() { npx wrangler "$@"; }

echo "== KV namespace g1t-domains"
if grep -q DOMAINS_KV_ID "$ROOT/services/deployments/wrangler.jsonc" "$ROOT/services/pages/wrangler.jsonc"; then
  id=$(cd "$ROOT" && w kv namespace list 2>/dev/null | tr -d '\n ' | grep -oE '"id":"[0-9a-f]{32}","title":"g1t-domains"' | grep -oE '[0-9a-f]{32}' | head -1 || true)
  if [ -z "$id" ]; then
    id=$(cd "$ROOT" && w kv namespace create g1t-domains </dev/null 2>&1 | grep -oE '[0-9a-f]{32}' | head -1 || true)
  fi
  [ -n "$id" ] || { echo "Could not create the namespace; is wrangler logged in? (npx wrangler whoami)"; exit 1; }
  sed -i "s/DOMAINS_KV_ID/$id/" "$ROOT/services/deployments/wrangler.jsonc" "$ROOT/services/pages/wrangler.jsonc"
  echo "Using $id; wrote it into both wrangler.jsonc files. Commit that."
else
  echo "Already set."
fi

cf() {
  local method="$1" path="$2" body="${3:-}"
  local auth=()
  if [ -n "${CLOUDFLARE_ZONE_TOKEN:-}" ]; then
    auth=(-H "Authorization: Bearer $CLOUDFLARE_ZONE_TOKEN")
  else
    auth=(-H "X-Auth-Email: $CLOUDFLARE_EMAIL" -H "X-Auth-Key: $CLOUDFLARE_API_KEY")
  fi
  curl -sS -X "$method" "$API$path" "${auth[@]}" -H "Content-Type: application/json" ${body:+--data "$body"}
}

echo "== Fallback origin $FALLBACK"
if [ -n "${CLOUDFLARE_ZONE_TOKEN:-}" ] || { [ -n "${CLOUDFLARE_API_KEY:-}" ] && [ -n "${CLOUDFLARE_EMAIL:-}" ]; }; then
  if cf GET "/zones/$ZONE_ID/dns_records?name=$FALLBACK" | grep -q "\"name\":\"$FALLBACK\""; then
    echo "DNS record exists."
  else
    cf POST "/zones/$ZONE_ID/dns_records" \
      "{\"type\":\"AAAA\",\"name\":\"$FALLBACK\",\"content\":\"100::\",\"proxied\":true,\"comment\":\"g1t custom domains: the Cloudflare for SaaS fallback origin, served by g1t-pages\"}" \
      | grep -q '"success":true' && echo "Added $FALLBACK AAAA 100:: (proxied)." || { echo "Could not add the DNS record."; exit 1; }
  fi
  answer=$(cf PUT "/zones/$ZONE_ID/custom_hostnames/fallback_origin" "{\"origin\":\"$FALLBACK\"}")
  if echo "$answer" | grep -q '"success":true'; then
    echo "Fallback origin set to $FALLBACK."
  elif echo "$answer" | grep -qE '"code":(1404|1456)'; then
    echo "Cloudflare for SaaS is not on for the zone yet. Turn it on (SSL/TLS, Custom Hostnames), then run this again."
  else
    echo "Could not set the fallback origin: $answer"; exit 1
  fi
else
  cat <<EOF
Set CLOUDFLARE_ZONE_TOKEN (or CLOUDFLARE_EMAIL and CLOUDFLARE_API_KEY) to do this for you, or by hand:
  1. On the g1t.page zone, add a proxied DNS record: type AAAA, name ${FALLBACK%%.*}, content 100::
  2. SSL/TLS, Custom Hostnames: set the fallback origin to $FALLBACK
EOF
fi

cat <<EOF
== Remaining by hand
  - Give the deployments service's API token SSL and Certificates: Edit on
    the g1t.page zone (it already has Workers Scripts and Account Analytics).
  - Deploy, which applies each part's migrations first:
      scripts/deploy.sh billing deployments pages web
EOF
