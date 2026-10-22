#!/bin/sh
# Connects Claude Code on this machine to g1t. g1t's Claude Code plugin
# records your sessions on g1t, loads a work item's context, and adds
# g1t's MCP server and commands; this prints the two commands that install
# it. With --cli it also installs the g1t CLI, which the plugin's hooks use:
#
#   curl -fsSL https://g1t.sh/install/claude.sh | sh
#   curl -fsSL https://g1t.sh/install/claude.sh | sh -s -- --cli
#
# It changes nothing else.
set -eu

BASE="${G1T_SITE:-https://g1t.sh}"

if [ "${1:-}" = "--cli" ]; then
  curl -fsSL "$BASE/install" | sh
fi

# The plugin's marketplace is published only on g1t.sh, whichever g1t it
# works with (a self-hosted one is G1T_HOST to its hooks).
cat <<EOF
Install g1t's plugin for Claude Code:

  claude plugin marketplace add https://g1t.sh/flagon-io/g1t-plugins.git
  claude plugin install g1t@g1t

The plugin's hooks use the g1t CLI (0.4.0 or later) and Node 18 or later.
If you do not have the CLI yet, or have an older one, install it
(curl -fsSL $BASE/install | sh) and sign in with \`g1t auth login\`.
Then, in Claude Code, run /mcp and choose plugin:g1t:g1t to sign its tools
in. The plugin adds g1t's MCP server itself: skip \`claude mcp add\`.

To keep the plugin current, run /plugin, open Marketplaces, choose g1t and
Enable auto-update: Claude Code doesn't update this marketplace otherwise.

Guide: https://docs.g1t.sh/guides/claude-code-plugin/
EOF
