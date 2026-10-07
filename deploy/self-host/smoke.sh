#!/usr/bin/env bash
# End-to-end check of a self-hosted g1t: sign up, confirm the email, make a
# workspace and a repository, push and clone over HTTP, open an issue, and
# read the code back through the site. Then the API on its own port (REST,
# OAuth metadata and MCP, with an access token), pull requests from a branch
# and from a fork merged onto main, the merge queue taking a pull request
# and giving it back, and every cron handler the scheduler runs.
#
#   ./smoke.sh                      # against the compose stack's defaults
#   G1T_URL=http://localhost:8787 MAIL_LOG=wrangler.log ./smoke.sh
#
# The confirmation link is read from Mailpit (MAILPIT_URL, the default) or,
# with MAIL_LOG set, from a log the mail Worker printed it to. API_URL and
# MCP_URL are where the API is (default: G1T_URL's host on port 8789).
# SCHEDULER_ONCE is the command that runs every cron once (scheduler.mjs
# --once, inside the g1t container); unset, that step is skipped:
#
#   SCHEDULER_ONCE="docker compose -f deploy/self-host/docker-compose.yml exec -T g1t \
#     node deploy/self-host/scheduler.mjs --once /data/generated/schedules.json" ./smoke.sh
#
# (In Git Bash on Windows, start the command with `env MSYS_NO_PATHCONV=1`
# so /data is not rewritten into a Windows path.)
# PACK_CACHE=off skips the check that a second clone is served from the
# clone pack cache.
#
# Needs curl, git and node (to read JSON).
set -euo pipefail

G1T_URL="${G1T_URL:-http://localhost:8787}"
API_URL="${API_URL:-$(node -e 'const u = new URL(process.argv[1]); u.port = "8789"; console.log(u.origin)' "$G1T_URL")}"
MCP_URL="${MCP_URL:-$API_URL/mcp}"
MAILPIT_URL="${MAILPIT_URL:-http://localhost:8025}"
MAIL_LOG="${MAIL_LOG:-}"
SCHEDULER_ONCE="${SCHEDULER_ONCE:-}"
# off: this installation keeps no clone packs (no PACK_STORE), so a second
# clone is not checked for a kept one.
PACK_CACHE="${PACK_CACHE:-on}"
RUN="$(date +%s)"
USER_NAME="smoke${RUN}"
EMAIL="${USER_NAME}@example.com"
PASSWORD="correct-horse-${RUN}"
WORKSPACE="ws${RUN}"
REPO="hello"
WORK="$(mktemp -d)"
JAR="$WORK/cookies"
trap 'rm -rf "$WORK"' EXIT

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }

# A form POST as a browser sends it, with the Origin the site checks.
post() {
  local path="$1"; shift
  curl -sS -o "$WORK/body" -w '%{http_code} %{redirect_url}' -b "$JAR" -c "$JAR" \
    -H "Origin: $G1T_URL" "$@" "$G1T_URL$path"
}
get() {
  curl -sS -o "$WORK/body" -w '%{http_code}' -b "$JAR" -c "$JAR" "$G1T_URL$1"
}
# An API call with the access token: method, path, optional JSON body. The
# answer is in $WORK/api; the status is printed.
api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -o "$WORK/api" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $TOKEN")
  [ -n "$body" ] && args+=(-H "content-type: application/json" --data "$body")
  curl "${args[@]}" "$API_URL$path"
}
# A field of the last API answer (or of FILE), by a JavaScript path: `json pull.number`.
json() {
  node -e 'const v = process.argv[2].split(".").reduce((o, k) => o?.[k], JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))); console.log(typeof v === "object" ? JSON.stringify(v) : v ?? "")' "${2:-$WORK/api}" "$1"
}
# Waits for pull request $1 to have status $2.
until_status() {
  local status=""
  for _ in $(seq 1 30); do
    [ "$(api GET "/repos/$WORKSPACE/$REPO/pulls/$1")" = 200 ] && status="$(json pull.status)"
    [ "$status" = "$2" ] && return 0
    sleep 1
  done
  fail "pull request #$1 is $status, not $2: $(head -c 400 "$WORK/api")"
}
# Whether main, cloned fresh, has a file.
main_has() {
  rm -rf "$WORK/main"
  git -c credential.helper= clone -q "$G1T_URL/$WORKSPACE/$REPO.git" "$WORK/main"
  [ -f "$WORK/main/$1" ]
}
# A commit on a new branch of $1 (a clone), pushed to $2.
commit_file() {
  local dir="$1" remote="$2" branch="$3" file="$4"
  (
    cd "$dir"
    git config user.name "Smoke Test"
    git config user.email "$EMAIL"
    git config commit.gpgsign false
    git switch -q -c "$branch" 2>/dev/null || git switch -q "$branch"
    mkdir -p "$(dirname "$file")"
    printf 'Changed by smoke.sh on %s.\n' "$branch" > "$file"
    git add . && git commit -qm "Add $file"
    git -c credential.helper= push -q "$remote" "HEAD:$branch"
  )
}

step "site answers at $G1T_URL"
[ "$(get /)" = 200 ] || fail "GET / did not answer 200"

step "sign up as $USER_NAME"
out="$(post /register --data-urlencode "username=$USER_NAME" --data-urlencode "email=$EMAIL" --data-urlencode "password=$PASSWORD")"
echo "$out"
case "$out" in 30[23]*) ;; *) fail "register: $out $(head -c 300 "$WORK/body")" ;; esac
# curl keeps Secure cookies only for https or localhost; carry it by hand.
grep -q g1t_session "$JAR" || fail "no session cookie"

step "confirm the email"
link=""
for _ in $(seq 1 20); do
  if [ -n "$MAIL_LOG" ]; then
    link="$(grep -ao "[a-z]*://[^ \"<]*/verify?token=[0-9a-zA-Z_-]*" "$MAIL_LOG" | tail -1 || true)"
  else
    id="$(curl -sS "$MAILPIT_URL/api/v1/search?query=to:$EMAIL" | sed -n 's/.*"ID":"\([^"]*\)".*/\1/p' | head -1)"
    [ -n "$id" ] && link="$(curl -sS "$MAILPIT_URL/api/v1/message/$id" | grep -ao '[a-z]*://[^ "<\\]*/verify?token=[0-9a-zA-Z_-]*' | head -1 || true)"
  fi
  [ -n "$link" ] && break
  sleep 1
done
[ -n "$link" ] || fail "no confirmation email arrived"
echo "$link"
[ "$(get "/verify?${link#*\?}")" = 200 ] || fail "verify"
grep -q "$USER_NAME" "$WORK/body" || fail "verify page does not name the account"

step "create workspace $WORKSPACE"
out="$(post /workspaces/new --data-urlencode "slug=$WORKSPACE" --data-urlencode "displayName=Smoke $RUN")"
echo "$out"
case "$out" in 30[23]*) ;; *) fail "workspace: $out $(head -c 300 "$WORK/body")" ;; esac

step "create repository $WORKSPACE/$REPO"
out="$(post /new --data-urlencode "workspace=$WORKSPACE" --data-urlencode "name=$REPO" --data-urlencode "description=Self-host smoke test" --data-urlencode "visibility=public" --data-urlencode "source=empty")"
echo "$out"
case "$out" in 30[23]*) ;; *) fail "repo: $out $(head -c 300 "$WORK/body")" ;; esac

step "push over HTTP"
remote="${G1T_URL/:\/\//://$USER_NAME:$PASSWORD@}/$WORKSPACE/$REPO.git"
git init -q -b main "$WORK/src"
(
  cd "$WORK/src"
  git config user.name "Smoke Test"
  git config user.email "$EMAIL"
  # A throwaway commit: never signed, whatever the global config says.
  git config commit.gpgsign false
  printf '# hello\n\nPushed to a self-hosted g1t.\n' > README.md
  mkdir -p src && printf 'fn main() {\n    println!("hello from g1t");\n}\n' > src/main.rs
  git add . && git commit -qm "First commit"
  git -c credential.helper= push -q "$remote" main
)
echo "pushed $(git -C "$WORK/src" rev-parse --short HEAD)"

step "clone over HTTP"
git -c credential.helper= clone -q "$G1T_URL/$WORKSPACE/$REPO.git" "$WORK/clone"
diff -q "$WORK/src/README.md" "$WORK/clone/README.md" || fail "clone differs"
echo "clone matches"

if [ "$PACK_CACHE" != off ]; then
  step "clone again: the pack comes from the cache"
  # The repos service says in Server-Timing whether the pack was kept.
  GIT_TRACE_CURL=1 GIT_TRACE_CURL_NO_DATA=1 git -c credential.helper= clone -q "$G1T_URL/$WORKSPACE/$REPO.git" "$WORK/again" 2> "$WORK/trace"
  grep -qi 'server-timing:.*pack;desc=hit' "$WORK/trace" || fail "the second clone's pack was not kept: $(grep -io 'pack;desc=[a-z]*' "$WORK/trace" | tr '\n' ' ')"
  diff -qr --exclude=.git "$WORK/clone" "$WORK/again" >/dev/null || fail "the kept pack differs"
  echo "hit"
fi

step "open an issue"
out="$(post "/$WORKSPACE/$REPO/issues/new" --data-urlencode "title=It works" --data-urlencode "body=Opened by smoke.sh")"
echo "$out"
case "$out" in 30[23]*/issues/1) ;; *) fail "issue: $out $(head -c 300 "$WORK/body")" ;; esac
[ "$(get "/$WORKSPACE/$REPO/issues/1")" = 200 ] || fail "issue page"
grep -q "It works" "$WORK/body" || fail "issue page does not show the title"

step "browse code in the site"
[ "$(get "/$WORKSPACE/$REPO/code")" = 200 ] || fail "code page"
grep -q "README.md" "$WORK/body" || fail "code page does not list README.md"
[ "$(get "/$WORKSPACE/$REPO/blob/main/src/main.rs")" = 200 ] || fail "blob page"
grep -q "hello from g1t" "$WORK/body" || fail "blob page does not show the file"
[ "$(get "/$WORKSPACE/$REPO/commits")" = 200 ] || fail "commits page"
grep -q "First commit" "$WORK/body" || fail "commits page does not show the commit"

step "make an access token"
out="$(post /settings/tokens --data-urlencode "intent=add-token" --data-urlencode "label=smoke" --data-urlencode "preset=full" --data-urlencode "expires=7")"
echo "$out"
TOKEN="$(grep -ao 'g1t_[0-9A-Za-z_-]*' "$WORK/body" | head -1 || true)"
[ -n "$TOKEN" ] || fail "no token in the tokens page: $out"
echo "token ${TOKEN:0:8}…"

step "the API answers at $API_URL"
[ "$(api GET /user)" = 200 ] || fail "GET /user: $(head -c 300 "$WORK/api")"
[ "$(json username)" = "$USER_NAME" ] || fail "GET /user names $(json username), not $USER_NAME"
[ "$(api GET /)" = 200 ] || fail "GET /"
[ "$(json mcp_url)" = "$MCP_URL" ] || fail "the API's index names $(json mcp_url) as MCP, not $MCP_URL"
[ "$(json git_url)" = "$G1T_URL/{owner}/{name}.git" ] || fail "git_url is $(json git_url)"
curl -sS -o "$WORK/api" "$API_URL/.well-known/oauth-authorization-server"
[ "$(json issuer)" = "$API_URL" ] || fail "the OAuth issuer is $(json issuer), not $API_URL"
[ "$(json authorization_endpoint)" = "$G1T_URL/oauth/authorize" ] || fail "people approve at $(json authorization_endpoint)"
echo "issuer $(json issuer)"
code="$(curl -sS -o "$WORK/api" -D "$WORK/headers" -w '%{http_code}' -X POST -H "content-type: application/json" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$MCP_URL")"
[ "$code" = 401 ] || fail "MCP without a token answered $code"
grep -qi "resource_metadata=\"$API_URL/.well-known/oauth-protected-resource/mcp\"" "$WORK/headers" || fail "MCP's challenge: $(grep -i www-authenticate "$WORK/headers")"
code="$(curl -sS -o "$WORK/api" -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$MCP_URL")"
[ "$code" = 200 ] && grep -q '"tools"' "$WORK/api" || fail "MCP tools/list: $code $(head -c 300 "$WORK/api")"
echo "MCP lists its tools at $MCP_URL"

step "a pull request from a branch, merged"
git -C "$WORK/clone" config credential.helper ""
commit_file "$WORK/clone" "$remote" from-branch docs/branch.md
[ "$(api POST "/repos/$WORKSPACE/$REPO/pulls" '{"title":"From a branch","branch":"from-branch","body":"Opened by smoke.sh"}')" = 200 ] \
  || fail "open from a branch: $(head -c 300 "$WORK/api")"
BRANCH_PULL="$(json pull.number)"
echo "pull request #$BRANCH_PULL ($(json pull.status))"
[ "$(get "/$WORKSPACE/$REPO/pull/$BRANCH_PULL")" = 200 ] && grep -q "From a branch" "$WORK/body" || fail "pull request page"
[ "$(api POST "/repos/$WORKSPACE/$REPO/pulls/$BRANCH_PULL/merge" '{}')" = 200 ] || fail "merge: $(head -c 300 "$WORK/api")"
until_status "$BRANCH_PULL" merged
main_has docs/branch.md || fail "main does not have the branch's change"
echo "merged onto main"

step "a pull request from a fork, merged"
[ "$(api POST "/repos/$WORKSPACE/$REPO/pulls" '{"title":"From a fork","agent":"smoke"}')" = 200 ] \
  || fail "open with a fork: $(head -c 300 "$WORK/api")"
FORK_PULL="$(json pull.number)"
fork_remote="$(json git.remote)"
echo "pull request #$FORK_PULL ($(json pull.status)), fork $fork_remote"
case "$fork_remote" in "$G1T_URL"/*) ;; *) fail "the fork's remote is not on $G1T_URL: $fork_remote" ;; esac
[ "$fork_remote" != "$G1T_URL/$WORKSPACE/$REPO.git" ] || fail "no fork was made"
authed_fork="${fork_remote/:\/\//://$USER_NAME:$TOKEN@}"
git -c credential.helper= clone -q "$authed_fork" "$WORK/fork"
commit_file "$WORK/fork" "$authed_fork" "$(git -C "$WORK/fork" branch --show-current)" docs/fork.md
[ "$(api POST "/repos/$WORKSPACE/$REPO/pulls/$FORK_PULL/ready" '{"summary":"Adds docs/fork.md, from a fork."}')" = 200 ] \
  || fail "ready: $(head -c 300 "$WORK/api")"
[ "$(api POST "/repos/$WORKSPACE/$REPO/pulls/$FORK_PULL/merge" '{}')" = 200 ] || fail "merge: $(head -c 300 "$WORK/api")"
until_status "$FORK_PULL" merged
main_has docs/fork.md || fail "main does not have the fork's change"
echo "merged onto main"

step "the merge queue takes a pull request, and gives it back"
[ "$(api PATCH "/repos/$WORKSPACE/$REPO/settings" '{"merge_queue":true}')" = 200 ] || fail "turn the queue on: $(head -c 300 "$WORK/api")"
git -C "$WORK/clone" fetch -q "$G1T_URL/$WORKSPACE/$REPO.git" main
git -C "$WORK/clone" switch -q -c queued FETCH_HEAD
commit_file "$WORK/clone" "$remote" queued docs/queued.md
[ "$(api POST "/repos/$WORKSPACE/$REPO/pulls" '{"title":"Through the queue","branch":"queued"}')" = 200 ] || fail "open: $(head -c 300 "$WORK/api")"
QUEUE_PULL="$(json pull.number)"
[ "$(api POST "/repos/$WORKSPACE/$REPO/pulls/$QUEUE_PULL/merge" '{}')" = 200 ] || fail "merge into the queue: $(head -c 300 "$WORK/api")"
[ "$(api GET "/repos/$WORKSPACE/$REPO/queue")" = 200 ] || fail "queue: $(head -c 300 "$WORK/api")"
[ "$(json enabled)" = true ] || fail "the queue is not on"
node -e 'const q = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const e = q.active.find((e) => e.number === Number(process.argv[2])); if (!e) process.exit(1); console.log(`#${e.number} is ${e.state} in the queue`)' "$WORK/api" "$QUEUE_PULL" \
  || fail "#$QUEUE_PULL is not in the queue: $(head -c 400 "$WORK/api")"
[ "$(get "/$WORKSPACE/$REPO/queue")" = 200 ] && grep -q "Through the queue" "$WORK/body" || fail "queue page"
# Testing a queued state needs a sandbox, and agents are off: take it out.
out="$(post "/$WORKSPACE/$REPO/pull/$QUEUE_PULL" --data-urlencode "action=unqueue")"
echo "unqueue: $out"
[ "$(api GET "/repos/$WORKSPACE/$REPO/queue")" = 200 ] || fail "queue"
node -e 'const q = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(q.active.some((e) => e.number === Number(process.argv[2])) ? 1 : 0)' "$WORK/api" "$QUEUE_PULL" \
  || fail "#$QUEUE_PULL is still in the queue"
[ "$(api PATCH "/repos/$WORKSPACE/$REPO/settings" '{"merge_queue":false}')" = 200 ] || fail "turn the queue off"
[ "$(api POST "/repos/$WORKSPACE/$REPO/pulls/$QUEUE_PULL/merge" '{}')" = 200 ] || fail "merge: $(head -c 300 "$WORK/api")"
until_status "$QUEUE_PULL" merged
main_has docs/queued.md || fail "main does not have the change"
echo "out of the queue, then merged onto main"

if [ -n "$SCHEDULER_ONCE" ]; then
  step "every cron handler runs"
  $SCHEDULER_ONCE || fail "a cron handler failed"
fi

printf '\nAll checks passed: %s/%s/%s\n' "$G1T_URL" "$WORKSPACE" "$REPO"
