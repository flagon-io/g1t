#!/bin/sh
# Connects Claude Code on this machine to g1t, so the sessions of your own
# agent are recorded onto the pull requests they belong to:
#
#   curl -fsSL https://g1t.sh/install/claude.sh | sh
#
# It downloads two small scripts into ~/.g1t, signs you in through the
# browser, and adds a hook to ~/.claude/settings.json. Needs Node 18 or
# later, which Claude Code itself runs on.
set -eu

BASE="${G1T_SITE:-https://g1t.sh}"

if ! command -v node >/dev/null 2>&1; then
  echo "g1t: Node 18 or later is needed (Claude Code runs on it too)." >&2
  exit 1
fi

mkdir -p "$HOME/.g1t"
curl -fsSL "$BASE/install/hook.mjs" -o "$HOME/.g1t/hook.mjs"
curl -fsSL "$BASE/install/setup.mjs" -o "$HOME/.g1t/setup.mjs"
# Read from the terminal, not from the pipe this script arrived on.
node "$HOME/.g1t/setup.mjs" < /dev/tty
