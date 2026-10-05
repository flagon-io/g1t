#!/usr/bin/env bash
# End-to-end check of a self-hosted g1t: sign up, confirm the email, make a
# workspace and a repository, push and clone over HTTP, open an issue, and
# read the code back through the site.
#
#   ./smoke.sh                      # against the compose stack's defaults
#   G1T_URL=http://localhost:8787 MAIL_LOG=wrangler.log ./smoke.sh
#
# The confirmation link is read from Mailpit (MAILPIT_URL, the default) or,
# with MAIL_LOG set, from a log the mail Worker printed it to.
set -euo pipefail

G1T_URL="${G1T_URL:-http://localhost:8787}"
MAILPIT_URL="${MAILPIT_URL:-http://localhost:8025}"
MAIL_LOG="${MAIL_LOG:-}"
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

printf '\nAll checks passed: %s/%s/%s\n' "$G1T_URL" "$WORKSPACE" "$REPO"
