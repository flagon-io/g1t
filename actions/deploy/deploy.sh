#!/usr/bin/env bash
# The g1t/deploy action's work (see README.md): opens a g1t.page build for
# this job with POST /repos/{owner}/{repo}/deployments/builds, masks its
# token and the project's build secrets, and runs `g1t-runner deploy` in
# the checkout with them. Reads the action's inputs as INPUT_* variables.
set -euo pipefail

api="${GITHUB_API_URL:-https://api.g1t.sh}"
api="${api%/}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set: run this in a g1t Actions job.}"
if [ -z "${INPUT_TOKEN:-}" ]; then
  echo "::error::The token input is empty: give the job's own token, \${{ github.token }}, with permissions: deployments: write."
  exit 1
fi

# JSON, with jq where there is one, else Python.
if command -v jq >/dev/null 2>&1; then
  field() { jq -r --arg key "$1" '.[$key] // empty | if type == "object" or type == "array" then tojson else tostring end'; }
  values() { jq -r --arg key "$1" '.[$key] // {} | .[] | tostring'; }
  message() { jq -r '.message // .error.message // empty' 2>/dev/null || true; }
  body() { jq -cn --arg project "$1" --arg sha "$2" '{project: $project, sha: $sha} | with_entries(select(.value != ""))'; }
elif command -v python3 >/dev/null 2>&1; then
  field() {
    python3 -c 'import json, sys
v = json.load(sys.stdin).get(sys.argv[1])
if v is None: sys.exit(0)
print(json.dumps(v, separators=(",", ":")) if isinstance(v, (dict, list)) else str(v).lower() if isinstance(v, bool) else v)' "$1"
  }
  values() { python3 -c 'import json, sys
for v in (json.load(sys.stdin).get(sys.argv[1]) or {}).values(): print(v)' "$1"; }
  message() { python3 -c 'import json, sys
d = json.load(sys.stdin); print(d.get("message") or (d.get("error") or {}).get("message") or "")' 2>/dev/null || true; }
  body() { python3 -c 'import json, sys
print(json.dumps({k: v for k, v in (("project", sys.argv[1]), ("sha", sys.argv[2])) if v}))' "$1" "$2"; }
else
  echo "::error::g1t/deploy needs jq or python3 on the machine."
  exit 1
fi

# The build, opened for this job.
request="$(body "${INPUT_PROJECT:-}" "${INPUT_SHA:-}")"
answer_file="$(mktemp)"
trap 'rm -f "${answer_file}"' EXIT
status="$(curl -sS -o "${answer_file}" -w '%{http_code}' -X POST \
  -H "Authorization: Bearer ${INPUT_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  --data "${request}" \
  "${api}/repos/${repo}/deployments/builds")" || {
  echo "::error::Could not reach ${api} to open the build."
  exit 1
}
answer="$(cat "${answer_file}")"
if [ "${status}" != "200" ]; then
  why="$(message <<<"${answer}")"
  echo "::error::g1t did not open the build (${status}): ${why:-no reason given}"
  exit 1
fi

# Nothing secret is printed before it is masked.
build_token="$(field token <<<"${answer}")"
echo "::add-mask::${build_token}"
while IFS= read -r secret; do
  [ -n "${secret}" ] && echo "::add-mask::${secret}"
done < <(values build_secrets <<<"${answer}")

deployment_id="$(field deploy_id <<<"${answer}")"
kind="$(field kind <<<"${answer}")"
url="$(field url <<<"${answer}")"
project="$(field project <<<"${answer}")"
branch="$(field branch <<<"${answer}")"
trusted="$(field trusted <<<"${answer}")"
{
  echo "deployment-id=${deployment_id}"
  echo "kind=${kind}"
  echo "url=${url}"
} >>"${GITHUB_OUTPUT:-/dev/null}"

if [ "${kind}" = "production" ]; then
  echo "Building ${project} for production, at ${url}"
else
  echo "Building the ${branch} preview of ${project}, at ${url}"
fi
if [ "${trusted}" != "true" ]; then
  echo "::notice::This run is not trusted with the project's build secrets (a pull request from outside, or a run that needed approval): it builds without them."
fi

# What the step gives wins over the project's own settings.
pick() { if [ -n "$1" ]; then echo "$1"; else field "$2" <<<"${answer}"; fi; }
export DEPLOY_ID="${deployment_id}"
export DEPLOY_TOKEN="${build_token}"
export G1T_API="${api}"
export ROOT_DIR="$(pick "${INPUT_ROOT_DIR:-}" root_dir)"
export BUILD_COMMAND="$(pick "${INPUT_BUILD_COMMAND:-}" build_command)"
export OUTPUT_DIR="$(pick "${INPUT_OUTPUT_DIR:-}" output_dir)"
export BUILD_AS="$(pick "${INPUT_BUILD_AS:-}" build_as)"
export DOCKERFILE="$(pick "${INPUT_DOCKERFILE:-}" dockerfile)"
export BUILD_ENV="$(field build_env <<<"${answer}")"
export BUILD_SECRETS="$(field build_secrets <<<"${answer}")"
unset GIT_REMOTE

runner="$(bash "${GITHUB_ACTION_PATH:-$(dirname "$0")}/runner.sh")"
if ! "${runner}" deploy --help 2>/dev/null | grep -q DEPLOY_ID; then
  echo "::error::${runner} is older than g1t/deploy needs: update it (g1t-runner update), or let the action download it by taking it off PATH."
  exit 1
fi
"${runner}" deploy
echo "Deployed: ${url}"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "Deployed ${project} (${kind}) to ${url}" >>"${GITHUB_STEP_SUMMARY}"
fi
