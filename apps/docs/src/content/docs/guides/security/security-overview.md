---
title: Security overview
description: Open alerts across a workspace by type and severity, how they move, which repositories have which feature on, and those most in need.
---

`g1t.sh/<owner>/-/security` shows every repository you can see findings in
(you need Write on it, as on its own Security page):

- **Totals.** Open secret scanning, code scanning and vulnerability alerts,
  by severity, and how many opened and closed in the last 30 days.
- **Open alerts, by day.** A daily count of open alerts of each type, from a
  snapshot g1t takes of every repository once a day. Show it as a table for
  the numbers.
- **Repositories, most in need first.** Each repository with its open
  critical and high alerts, and which features are on: push protection
  (always), custom patterns, code scanning (when it last reported),
  dependency review and security updates.

The overview's tabs also lead to the workspace's
[bypass requests](/guides/security/secret-protection/#delegated-bypass),
[custom patterns](/guides/security/secret-protection/#custom-patterns) and
Security settings.

## Private repositories

The overview counts private repositories on the g1t plan, which
[Security and quality](/guides/security/pricing/) comes with. A workspace
without the plan, with private repositories, sees each repository's open
secret and vulnerability alerts as a list instead, which is free, and a
prompt to start the plan. A workspace with only public repositories sees the
whole overview free.

## API

`GET /workspaces/{workspace}/security/overview` returns the same, with
`days` (7 to 90, 30 by default) for the trend. Its scope is
`security:read`; over MCP it is the [`security` tool](/reference/mcp/#security)'s
`overview` action. Alerts across a workspace are at
`GET /workspaces/{workspace}/secret-scanning/alerts`,
`/code-scanning/alerts` and `/vulnerability-alerts`.
