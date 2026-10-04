"""Makes what Deployments needs that `wrangler login` cannot: a proxied
wildcard DNS record on the apps' zone, and an API token for the deployments
service (Workers Scripts: Edit, Account Analytics: Read).

Run by scripts/setup-deployments.sh with CLOUDFLARE_EMAIL and
CLOUDFLARE_API_KEY (a Global API Key) set. Prints only ids and outcomes,
never the key or the new token. Skips what exists.
"""
import json
import os
import sys
import urllib.error
import urllib.request

ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID") or "1e6f2cffa3f445920836e8ebe446bb58"
EMAIL = os.environ.get("CLOUDFLARE_EMAIL", "")
KEY = os.environ.get("CLOUDFLARE_API_KEY", "")
ZONE = os.environ.get("G1T_APPS_ZONE", "g1t.page")
TOKEN_FILE = os.environ["TOKEN_FILE"]
API = "https://api.cloudflare.com/client/v4"

if not KEY or not EMAIL:
    sys.exit("CLOUDFLARE_EMAIL and CLOUDFLARE_API_KEY must be set")


def call(method, path, body=None):
    request = urllib.request.Request(
        API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "X-Auth-Email": EMAIL,
            "X-Auth-Key": KEY,
            "Content-Type": "application/json",
            # Cloudflare refuses Python's default user agent.
            "User-Agent": "g1t-setup",
        },
    )
    try:
        return json.load(urllib.request.urlopen(request))
    except urllib.error.HTTPError as error:
        return json.loads(error.read() or b"{}") | {"http": error.code}


zones = call("GET", f"/zones?name={ZONE}")
if not zones.get("result"):
    sys.exit(f"zone {ZONE} not found: {zones.get('errors')}")
zone = zones["result"][0]["id"]

records = call("GET", f"/zones/{zone}/dns_records?name=*.{ZONE}")
if records.get("result"):
    print(f"*.{ZONE}: record exists")
else:
    made = call("POST", f"/zones/{zone}/dns_records", {
        "type": "AAAA", "name": "*", "content": "100::", "proxied": True, "ttl": 1,
        "comment": "g1t deployments: every app goes to the dispatch Worker",
    })
    print(f"*.{ZONE}:", "record created" if made.get("success") else made.get("errors"))

if os.path.exists(TOKEN_FILE):
    print("token: exists in .credentials; not making another")
    sys.exit(0)

groups = call("GET", "/user/tokens/permission_groups")
wanted = {"Workers Scripts Write", "Account Analytics Read"}
ids = [g["id"] for g in groups.get("result", []) if g["name"] in wanted]
if len(ids) != len(wanted):
    sys.exit("could not find the permission groups for the token")
created = call("POST", "/user/tokens", {
    "name": "g1t deployments service (Workers for Platforms uploads, analytics)",
    "policies": [{
        "effect": "allow",
        "resources": {f"com.cloudflare.api.account.{ACCOUNT}": "*"},
        "permission_groups": [{"id": i} for i in ids],
    }],
})
if not created.get("success"):
    sys.exit(f"token not created: {created.get('errors')}")
os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
with open(TOKEN_FILE, "w", encoding="utf-8") as f:
    f.write(created["result"]["value"] + "\n")
print("token: created and saved to .credentials")
