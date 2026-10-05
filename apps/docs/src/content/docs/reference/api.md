---
title: API reference
description: The REST API at api.g1t.sh, its authentication, errors and conventions, and a page for every endpoint.
---

The REST API lives at `https://api.g1t.sh`. It exposes the same operations
as the [MCP server](/reference/mcp/): every endpoint names the MCP tool that
does the same thing, with the same inputs.

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
[access token](https://g1t.sh/settings) as a bearer token:

```sh
curl https://api.g1t.sh/user \
  -H "Authorization: Bearer $G1T_TOKEN"
```

Public data can be read without a token. A token that is not valid is
rejected with `401` rather than treated as anonymous. Each endpoint's page
says whether it needs a token.

A [workspace's own token](/guides/workspaces/#workspace-access-tokens) acts
as the workspace. The token a g1t agent works with can use only the
operations its task needs, in its own repository.

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
curl -X PATCH https://api.g1t.sh/repos/syntaqx/hello/settings \
  -H "Authorization: Bearer $G1T_TOKEN" -d '{"count_agent_approvals": false}'
curl -X PATCH https://api.g1t.sh/repos/syntaqx/hello/settings \
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
| 402 | `payment_required` | The workspace has no agent credit. Only endpoints that start an agent answer this. See [usage and billing](/guides/usage-and-billing/#when-credit-runs-out). |
| 403 | `forbidden` | You are signed in but not allowed to do this. |
| 404 | `not_found` | It does not exist, or you cannot see it. A path that is not an endpoint answers this too. |
| 409 | `conflict` | The request conflicts with the current state. |
| 422 | `invalid` | The input is not valid. |

Branch on `code`, not on `message`: messages are written for people and
may change.

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
| [Repositories](/reference/api/repositories/list-repos/) | A repository, how it handles pull requests, and its timeline. |
| [Issues](/reference/api/issues/list-issues/) | What should change, with labels and comments, and assigning it to the g1t agent. |
| [Plans](/reference/api/plans/plan-work/) | An [outcome](/guides/outcomes/) turned into issues. |
| [Pull requests](/reference/api/pull-requests/list-pull-requests/) | Proposed changes: reviews, merging, the merge queue, and messages to the agent at work. |
| [Sessions](/reference/api/sessions/read-session/) | The record of how a pull request was made. |
| [Actions](/reference/api/actions/list-workflows/) | Workflows, their runs and their logs. |
| [Secrets and variables](/reference/api/secrets-and-variables/list-actions-secrets/) | Values workflows and deployments read. |
| [Webhooks](/reference/api/webhooks/list-webhooks/) | Events sent to your own address. |
| [Integrations](/reference/api/integrations/list-integrations/) | Model providers, alert sources and issue trackers. |
