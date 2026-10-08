---
title: API reference
description: The REST API at api.g1t.sh, its authentication, errors and conventions, and a page for every endpoint.
---

The REST API lives at `https://api.g1t.sh`. It exposes the same operations
as the [MCP server](/reference/mcp/): every endpoint names the MCP tool and
action that do the same thing, with the same inputs.

This page covers what every endpoint shares. The pages under each resource
in the sidebar document one endpoint each: its parameters, an example
request and response, and its errors. The machine-readable description is
at [api.g1t.sh/openapi.json](https://api.g1t.sh/openapi.json), and the
[explorer](/api/reference/) lets you call the API from the browser.

## Start at the root

The API is public. Anything you could see on the site without signing in,
you can read without a token. `GET https://api.g1t.sh/` returns where
everything is, as URL templates:

```sh
curl https://api.g1t.sh/
```

```json
{
  "documentation_url": "https://docs.g1t.sh/reference/api/",
  "openapi_url": "https://api.g1t.sh/openapi.json",
  "mcp_url": "https://mcp.g1t.sh",
  "current_user_url": "https://api.g1t.sh/user",
  "repository_url": "https://api.g1t.sh/repos/{owner}/{name}",
  "issues_url": "https://api.g1t.sh/repos/{owner}/{name}/issues{?state,label}",
  "pulls_url": "https://api.g1t.sh/repos/{owner}/{name}/pulls{?state}"
}
```

The response has more entries than shown here.

## Authentication

A token is needed to change anything, and to see what is private. Send an
[access token](https://g1t.sh/settings/tokens) as a bearer token:

```sh
curl https://api.g1t.sh/user \
  -H "Authorization: Bearer $G1T_TOKEN"
```

Public data can be read without a token. A token that is not valid is
rejected with `401` rather than treated as anonymous. Each endpoint's page
says whether it needs a token.

A [workspace's own token](/guides/workspaces/#workspace-access-tokens) acts
as the workspace. The token g1t works with can use only the
operations its task needs, in its own repository.

### Scopes

Each endpoint needs one [scope](/guides/authentication/#scopes), such as
`issues:read` to read an issue or `issues:write` to open one. Its page
says which, and the [OpenAPI document](https://api.g1t.sh/openapi.json)
gives it as `x-scope` on each operation, beside `x-mcp-tool` and
`x-mcp-action`, the MCP tool and action that do the same:

```json
{
  "operationId": "get_issue",
  "x-operation": "get_issue",
  "x-mcp-tool": "issue",
  "x-mcp-action": "get",
  "x-scope": "issues:read"
}
```

`x-scope` is `null` for `GET /user`, which any token may use. A token
needs the scope, and whoever it acts as needs a role that allows the call.
A token reaches every workspace and repository whoever it acts as can.

## Signing in from a tool

A tool gets a token by having a person approve a short code in their
browser: [start signing in](/reference/api/accounts/device-code/), then
[finish signing in](/reference/api/accounts/device-token/). See
[signing in from a tool](/guides/authentication/#signing-in-from-a-tool).

Applications that can open a browser use OAuth instead. See
[signing in with OAuth](/guides/authentication/#signing-in-with-oauth).

| Method | Path | |
| --- | --- | --- |
| `GET` | `/.well-known/oauth-authorization-server` | Where the endpoints are. |
| `POST` | `/oauth/register` | Register a client. Body: `client_name`, `redirect_uris`. |
| `POST` | `/oauth/token` | Exchange a code, or refresh. Form-encoded or JSON. |

Accounts are created in a browser only. There is no registration endpoint
for accounts.

## Requests and responses

Request bodies are JSON.

Every name in a body is `snake_case`, both ways: responses, errors, MCP
results and [webhook](/guides/webhooks/) payloads. Request bodies take the
same names as the MCP tools, and also accept the `camelCase` spelling:

```sh
# Both turn off counting agents' approvals.
curl -X PATCH https://api.g1t.sh/repos/flagon-io/hello/settings \
  -H "Authorization: Bearer $G1T_TOKEN" -d '{"count_agent_approvals": false}'
curl -X PATCH https://api.g1t.sh/repos/flagon-io/hello/settings \
  -H "Authorization: Bearer $G1T_TOKEN" -d '{"countAgentApprovals": false}'
```

When a body gives a field both ways, the `snake_case` one is used.

Names you chose are never changed: a workflow's `inputs`, the names of
secrets and variables, an environment's `env`, a job's `outputs` and
`matrix`, labels and headers come back exactly as they were written.

A successful request answers `200` with the result as the body: an object,
a list, or `true` for a deletion. There is no envelope around it.

In paths, `{owner}` is the workspace that owns the repository and `{name}`
is the repository's name. Issues and pull requests are addressed by
`{number}`; the two share one sequence of numbers per repository, so a
number names exactly one of them.

## Errors

Errors are JSON with a stable `code` and a human-readable `message`.

```json
{ "error": { "code": "not_found", "message": "Repository not found." } }
```

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `unauthenticated` | A token is required, or the one sent is not valid. |
| 402 | `payment_required` | The workspace cannot pay for this: to start an agent it needs the g1t plan or a card check, or it is at a limit; to make a repository private, or move a private one in, a free workspace needs room in its free private storage. Only endpoints that start an agent, change a repository's visibility or transfer it answer this. See [usage and billing](/guides/usage-and-billing/#when-work-is-stopped). |
| 403 | `forbidden` | You are signed in but not allowed to do this: your role is not enough, or the token lacks a scope, which `needed_scope` names. |
| 404 | `not_found` | It does not exist, or you cannot see it. A path that is not an endpoint answers this too. |
| 409 | `conflict` | The request conflicts with the current state. |
| 422 | `invalid` | The input is not valid. |

Branch on `code`, not on `message`: messages are written for people and
may change.

When an access token lacks the scope a call needs, the `403` also names
that scope in `needed_scope`:

```json
{
  "error": {
    "code": "forbidden",
    "message": "This access token needs the issues:write scope to use create_issue.",
    "needed_scope": "issues:write"
  }
}
```

Give the token that scope in
[Settings → Access tokens](https://g1t.sh/settings/tokens), or use another
token. A `403` for any other reason has no `needed_scope`.

## Lists

Lists come newest first, unless an endpoint says otherwise. Most return
everything up to a limit; the few that grow without bound take a cursor:

| Endpoint | Limit | Next page |
| --- | --- | --- |
| [List repositories](/reference/api/repositories/list-repos/) | 50 | None |
| [List issues](/reference/api/issues/list-issues/) | 100 | None |
| [List pull requests](/reference/api/pull-requests/list-pull-requests/) | 100 | None |
| [List repository events](/reference/api/repositories/list-events/) | 50 | `before`: the id of the last event you have |
| [List workflow runs](/reference/api/actions/list-workflow-runs/) | `per_page`, at most 100 and 50 if not given | None |
| [List webhook deliveries](/reference/api/webhooks/list-webhook-deliveries/) | 50 | None |
| [List notifications](/reference/api/notifications/list-notifications/) | `per_page`, at most 100 and 30 if not given | `cursor`: the `next` of the page before |
| [Read a session](/reference/api/sessions/read-session/) | None | `after`: the last `seq` you have |
| [Get a job's log](/reference/api/actions/get-job-logs/) | 500 chunks | `after`: the last `seq` you have |

## Identifiers and times

Issues and pull requests are addressed by repository and number. Other ids
are [TypeIDs](https://github.com/jetify-com/typeid): a prefix naming the
kind of thing, then a UUIDv7 in base32, for example
`pr_01jb2k7x9hfq0b3zj0f5s2m8ra`. They sort by creation time.

Times are RFC 3339 in UTC, with milliseconds, such as
`2026-10-01T18:04:11.482Z`.

## Resources

| Resource | |
| --- | --- |
| [Accounts](/reference/api/accounts/whoami/) | Signing in from a tool, and who a token acts as. |
| [Workspaces](/reference/api/workspaces/create-workspace/) | Creating a workspace. |
| [Notifications](/reference/api/notifications/list-notifications/) | Your inbox: its threads, why you were told of each, marking them read, done, saved or snoozed, and what you subscribe to and watch. See [your inbox](/guides/inbox/). |
| [Billing](/reference/api/billing/get-usage/) | A workspace's usage by product, project and day, its budget, its AI credit, its invoices and its [AI Gateway](/guides/ai-gateway/) requests. See [usage and billing](/guides/usage-and-billing/). |
| [Invites](/reference/api/invites/list-invites/) | Your invites while g1t is invite-only, and inviting people into a workspace by email. |
| [Repositories](/reference/api/repositories/list-repos/) | A repository, how it handles pull requests, and its timeline. |
| [Access](/reference/api/access/list-collaborators/) | Who has which role on a repository, invitations, outside collaborators, and a workspace's base permission. |
| [Secret scanning](/reference/api/secret-scanning/list-secret-scanning-alerts/) | Secrets found in pushes and history, where each one is, bypassing push protection and reviewing bypass requests, validity checks, and custom patterns. See [secret protection](/guides/security/secret-protection/). |
| [Code scanning](/reference/api/code-scanning/list-code-scanning-alerts/) | SARIF uploads, the alerts and analyses they make, and fixing an alert with g1t. See [code scanning](/guides/security/code-scanning/). |
| [Supply chain](/reference/api/supply-chain/list-vulnerability-alerts/) | Vulnerability alerts, the dependency graph, its SPDX SBOM, and comparing dependencies. See [supply chain](/guides/security/supply-chain/). |
| [Security settings](/reference/api/security-settings/get-security-settings/) | When pull request checks fail, dependency review's policy, delegated bypass, validity checks and a workspace's overview. |
| [Issues](/reference/api/issues/list-issues/) | What should change, with labels and comments, and assigning it to g1t. |
| [Plans](/reference/api/plans/plan-work/) | An [outcome](/guides/outcomes/) turned into issues. |
| [Pull requests](/reference/api/pull-requests/list-pull-requests/) | Proposed changes: reviews, merging, the merge queue, and messages to the agent at work. |
| [Sessions](/reference/api/sessions/read-session/) | The record of how a pull request was made. |
| [Actions](/reference/api/actions/list-workflows/) | Workflows, their runs and their logs. |
| [Run protection](/reference/api/run-protection/update-environment/) | Environments' protection rules and the reviews of the jobs they hold, approving a pull request's run from outside, a job token's default permissions, and repository dispatch. See [GitHub Actions](/guides/actions/#environments). |
| [Secrets and variables](/reference/api/secrets-and-variables/list-actions-secrets/) | Values workflows and deployments read. |
| [Webhooks](/reference/api/webhooks/list-webhooks/) | Events sent to your own address. |
| [Integrations](/reference/api/integrations/list-integrations/) | Model providers, alert sources and issue trackers. |
