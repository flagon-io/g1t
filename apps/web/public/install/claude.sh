#!/bin/sh
# Connects Claude Code on this machine to g1t. g1t's Claude Code plugin
# records your sessions on g1t, loads an issue's work context, and adds
# g1t's MCP server and commands; this prints the two commands that install
# it. With --cli it also installs the g1t CLI, which the plugin's hooks use:
#
#   curl -fsSL https://g1t.sh/install/claude.sh | sh
#   curl -fsSL https://g1t.sh/install/claude.sh | sh -s -- --cli
#
# It changes nothing else. An earlier version of this script installed a
# hook in ~/.g1t; if that is there, it is brought up to date, and you can
# remove it once the plugin is installed (see below).
set -eu

BASE="${G1T_SITE:-https://g1t.sh}"

if [ "${1:-}" = "--cli" ]; then
  curl -fsSL "$BASE/install" | sh
fi

if [ -f "$HOME/.g1t/hook.mjs" ]; then
  curl -fsSL "$BASE/install/hook.mjs" -o "$HOME/.g1t/hook.mjs"
  echo "Updated the earlier g1t hook in ~/.g1t/hook.mjs. The plugin replaces it:"
  echo "once the plugin is installed, remove the \`node \"$HOME/.g1t/hook.mjs\"\`"
  echo "entries from ~/.claude/settings.json, so a session is not recorded twice."
  echo
fi

cat <<EOF
Install g1t's plugin for Claude Code:

  claude plugin marketplace add $BASE/flagon-io/g1t.git
  claude plugin install g1t@g1t

The plugin's hooks use the g1t CLI (0.3.2 or later) and Node 18 or later.
If you do not have the CLI yet, or have an older one, install it
(curl -fsSL $BASE/install | sh) and sign in with \`g1t auth login\`.
Then, in Claude Code, run /mcp and choose plugin:g1t:g1t to sign its tools
in. The plugin adds g1t's MCP server itself: skip \`claude mcp add\`.

Guide: https://docs.g1t.sh/guides/claude-code-plugin/
EOF
