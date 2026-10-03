---
title: API
description: Authentication, errors and the endpoints of the REST API.
---

The REST API lives at `https://api.g1t.sh`. It exposes the same operations as
the [MCP server](/guides/bring-your-own-agent/).

This page is an overview. The [API reference](/api/reference/) lists
every endpoint with its parameters and lets you call them from the page. The
machine-readable description is at
[api.g1t.sh/openapi.json](https://api.g1t.sh/openapi.json).

## Start at the root

The API is public. Anything you could see on the site without signing in,
you can read without a token. `GET https://api.g1t.sh/` returns where
everything is, as URL templates:

```sh
curl https://api.g1t.sh/
```

```json
{
  "documentation_url": "https://docs.g1t.sh/api/reference/",
  "current_user_url": "https://api.g1t.sh/user",
  "repository_url": "https://api.g1t.sh/repos/{owner}/{name}",
  "issues_url": "https://api.g1t.sh/repos/{owner}/{name}/issues{?state,label}",
  "pulls_url": "https://api.g1t.sh/repos/{owner}/{name}/pulls{?state}"
}
```

## Authentication

A token is needed to change anything, and to see what is private. Send an
[access token](https://g1t.sh/settings) as a bearer token:

```sh
curl https://api.g1t.sh/user \
  -H "Authorization: Bearer $G1T_TOKEN"
```

Public data can be read without a token. A token that is not valid is
rejected with `401` rather than treated as anonymous.

## Signing in from a tool

A tool gets a token by having a person approve a short code in their
browser. See [signing in from a tool](/guides/authentication/#signing-in-from-a-tool).

| Method | Path | |
| --- | --- | --- |
| `POST` | `/device/code` | Start a sign-in. Body: `client_name`. |
| `POST` | `/device/token` | Ask whether it was approved. Body: `device_code`. |

Applications that can open a browser use OAuth instead. See
[signing in with OAuth](/guides/authentication/#signing-in-with-oauth).

| Method | Path | |
| --- | --- | --- |
| `GET` | `/.well-known/oauth-authorization-server` | Where the endpoints are. |
| `POST` | `/oauth/register` | Register a client. Body: `client_name`, `redirect_uris`. |
| `POST` | `/oauth/token` | Exchange a code, or refresh. Form-encoded or JSON. |

Accounts are created in a browser only. There is no registration endpoint
for accounts.

## Errors

Errors are JSON with a stable `code` and a human-readable `message`.

```json
{ "error": { "code": "not_found", "message": "Repository not found." } }
```

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `unauthenticated` | A token is required, or the one sent is not valid. |
| 403 | `forbidden` | You are signed in but not allowed to do this. |
| 404 | `not_found` | It does not exist, or you cannot see it. |
| 409 | `conflict` | The request conflicts with the current state. |
| 422 | `invalid` | The input is not valid. |

## Accounts and repositories

In paths, `{owner}` is the workspace that owns the repository.

| Method | Path | |
| --- | --- | --- |
| `GET` | `/user` | Who the token acts as, and the workspaces it can work in. `kind` is `user`, or `workspace` for a [workspace's own token](/guides/authentication/#workspace-access-tokens). |
| `POST` | `/workspaces` | Create a workspace. Body: `slug`, `name`. |
| `GET` | `/repos?q=` | Repositories you can see. |
| `POST` | `/repos` | Create one. Body: `workspace`, `name`, `description`, `private`, and `import_url` to copy a public repository's default branch. |
| `GET` | `/repos/{owner}/{name}` | One repository. |
| `PATCH` | `/repos/{owner}/{name}` | Change it. Body: `description`, `private`, and `protected` to refuse pushes to the default branch. Members only. |
| `GET` | `/repos/{owner}/{name}/settings` | How it handles pull requests. |
| `PATCH` | `/repos/{owner}/{name}/settings` | Change that. Body, all optional: `required_approvals`, `count_agent_approvals`, `allow_ignoring_checks`, `require_up_to_date`, `agent_review`, `max_revisions`, `auto_merge`. Members only. |
| `GET` | `/repos/{owner}/{name}/events?before=` | Its timeline, newest first. |

## Issues

Issues and pull requests share one sequence of numbers per repository.

| Method | Path | |
| --- | --- | --- |
| `GET` | `/repos/{owner}/{name}/issues?state=&label=` | Issues, newest first. `state` is `open` or `closed`. |
| `POST` | `/repos/{owner}/{name}/issues` | Open one. Body: `title`, `body`, `labels`, `checks`. |
| `GET` | `/repos/{owner}/{name}/issues/{number}` | An issue, its comments and its pull requests. |
| `PATCH` | `/repos/{owner}/{name}/issues/{number}` | Change `title`, `body` or `labels`. |
| `POST` | `/repos/{owner}/{name}/issues/{number}/close` | Close. Body: `reason`, `completed` or `not_planned`. |
| `POST` | `/repos/{owner}/{name}/issues/{number}/reopen` | Reopen. |
| `POST` | `/repos/{owner}/{name}/plans` | Turn an outcome into a plan. Body: `brief`. Returns `planId`; the plan takes a minute or two to write. Members only. |
| `GET` | `/repos/{owner}/{name}/plans/{plan}` | The plan: its `status` and the issues it proposes. |
| `POST` | `/repos/{owner}/{name}/plans/{plan}/apply` | Open its issues. Body: `assign` to put g1t agents on them in dependency order, `keep` to open only some, by position from 1. |
| `POST` | `/repos/{owner}/{name}/issues/{number}/assign` | Assign it to the [g1t agent](/guides/g1t-agents/), which opens a pull request and sees it through. Body: `instructions` (optional). Returns the pull request. Preview: enabled accounts only. |
| `POST` | `/repos/{owner}/{name}/issues/{number}/comments` | Comment. Body: `body`. The number may be a pull request's, and then `path` and `line` put the comment on a line of its change. |
| `GET` | `/repos/{owner}/{name}/labels` | The labels in use. |

```sh
curl -X POST https://api.g1t.sh/repos/syntaqx/hello/issues \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Greeting should name the caller",
    "body": "Take a name from the first argument; fall back to world.",
    "labels": ["feature"],
    "checks": ["cargo build"]
  }'
```

A closed issue says how it was closed. `resolvedBy` is the number of the
pull request whose merge closed it:

```json
{
  "issue": { "number": 12, "state": "closed", "reason": "completed", "resolvedBy": 14 },
  "pulls": [
    { "number": 13, "status": "closed", "supersededBy": 14 },
    { "number": 14, "status": "merged", "mergedBy": "syntaqx" }
  ],
  "comments": []
}
```

## Pull requests

| Method | Path | |
| --- | --- | --- |
| `GET` | `/repos/{owner}/{name}/pulls?state=` | Pull requests, newest first. |
| `POST` | `/repos/{owner}/{name}/pulls` | Open one. Body: `issue`, `title`, `agent`, and for a branch `branch`, `body`. |
| `GET` | `/repos/{owner}/{name}/pulls/{number}` | A pull request, its comments and its issue. |
| `GET` | `/repos/{owner}/{name}/pulls/{number}/changes` | The files it changes, with diffs. |
| `POST` | `/repos/{owner}/{name}/pulls/{number}/ready` | Mark ready for review. Body: `summary`. |
| `POST` | `/repos/{owner}/{name}/pulls/{number}/close` | Close without merging. |
| `POST` | `/repos/{owner}/{name}/pulls/{number}/reviews` | Give a verdict. Body: `verdict` (`approve` or `request_changes`), `body`. Not on your own pull request. |
| `POST` | `/repos/{owner}/{name}/pulls/{number}/merge` | Land it on `main`. Body: `keep_issue_open`, `ignore_checks`. Workspace members only; `409` if it is a draft or its checks have not passed. If `main` has moved, the pull request is brought up to date first and lands when that is done: the response is the pull request, still open, and `landing` is true on it until then. A repository that requires pull requests to be up to date answers `409` instead. |

Opening a pull request returns the git remote of its fork:

```json
{
  "pull": { "id": "pr_01…", "number": 14, "status": "draft", "issue": 12 },
  "git": { "remote": "https://g1t.sh/pulls/pr_01….git" }
}
```

`title` defaults to the issue's title, and is required when there is no
`issue`.

Send `branch` to open the pull request from a branch already pushed to the
repository. No fork is made, `git.remote` is the repository itself, and the
pull request is `open` at once:

```json
{
  "pull": { "number": 15, "status": "open", "branch": "my-change", "fork": null },
  "git": { "remote": "https://g1t.sh/syntaqx/hello.git" }
}
```

Merging a pull request made for an issue closes the issue and records the
pull request in the issue's `resolvedBy`. Other pull requests for that issue
that are still a draft or open are closed with `supersededBy` set. Send
`"keep_issue_open": true` to merge without any of that.

Fetching one pull request also returns:

| Field | |
| --- | --- |
| `pull.files` | The files it changes, with lines added and removed. |
| `overlaps` | Other pull requests in progress changing the same files. |
| `behind` | Whether `main` has moved since it was made. |
| `checks` | The latest run of the acceptance checks. |
| `comments` | Comments and reviews, with `path`, `line` and `verdict`. |

### Checks

A pull request carries `checkStatus`: `queued`, `running`, `passed`, `failed`,
`errored`, or `null` when no checks have run against its head. Fetching one
pull request also returns the latest run in full:

```json
{
  "pull": { "number": 14, "status": "open", "checkStatus": "failed" },
  "checks": {
    "headCommit": "8f3c2e1…",
    "status": "failed",
    "results": [
      { "command": "cargo test", "passed": false, "exitCode": 101, "output": "…", "durationMs": 8420 }
    ]
  }
}
```

Checks are started by g1t, not through the API. They run when a pull
request becomes ready for review and again when its head moves.

## Sessions

| Method | Path | |
| --- | --- | --- |
| `GET` | `/repos/{owner}/{name}/pulls/{number}/session?after=` | Entries after a sequence number. |
| `POST` | `/repos/{owner}/{name}/pulls/{number}/session` | Append. Body: `entries`. |

```sh
curl -X POST https://api.g1t.sh/repos/syntaqx/hello/pulls/14/session \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entries": [{"kind": "message", "text": "Reading src/main.rs."}]}'
```

Up to 200 entries can be appended per request.

## Identifiers and times

Issues and pull requests are addressed by repository and number. Other ids
are [TypeIDs](https://github.com/jetify-com/typeid): a prefix naming the
kind of thing, then a UUIDv7 in base32, for example
`pr_01jb2k7x9hfq0b3zj0f5s2m8ra`. They sort by creation time.

Times are RFC 3339 in UTC, such as `2026-10-01T18:04:11.482Z`.

## Field names

Responses use `camelCase`. Request bodies take the same names as the MCP
tools, in `snake_case`, and also accept `camelCase`, so you can send back a
field exactly as you read it:

```sh
# Both turn off counting agents' approvals.
curl -X PATCH https://api.g1t.sh/repos/acme/web/settings \
  -H "Authorization: Bearer g1t_…" -d '{"count_agent_approvals": false}'
curl -X PATCH https://api.g1t.sh/repos/acme/web/settings \
  -H "Authorization: Bearer g1t_…" -d '{"countAgentApprovals": false}'
```

When a body gives a field both ways, the `snake_case` one is used.
