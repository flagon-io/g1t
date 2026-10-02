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

## Authentication

Send an [access token](https://g1t.sh/settings) as a bearer token:

```sh
curl https://api.g1t.sh/v1/user \
  -H "Authorization: Bearer $G1T_TOKEN"
```

Public data can be read without a token. A token that is not valid is
rejected with `401` rather than treated as anonymous.

## Signing in from a tool

A tool gets a token by having a person approve a short code in their
browser. See [signing in from a tool](/guides/authentication/#signing-in-from-a-tool).

| Method | Path | |
| --- | --- | --- |
| `POST` | `/v1/device/code` | Start a sign-in. Body: `client_name`. |
| `POST` | `/v1/device/token` | Ask whether it was approved. Body: `device_code`. |

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
| `GET` | `/v1/user` | The account the token belongs to, and its workspaces. |
| `POST` | `/v1/workspaces` | Create a workspace. Body: `slug`, `name`. |
| `GET` | `/v1/repos?q=` | Repositories you can see. |
| `POST` | `/v1/repos` | Create one. Body: `workspace`, `name`, `description`, `private`. |
| `GET` | `/v1/repos/{owner}/{name}` | One repository. |
| `GET` | `/v1/repos/{owner}/{name}/events?before=` | Its timeline, newest first. |

## Issues

Issues and pull requests share one sequence of numbers per repository.

| Method | Path | |
| --- | --- | --- |
| `GET` | `/v1/repos/{owner}/{name}/issues?state=&label=` | Issues, newest first. `state` is `open` or `closed`. |
| `POST` | `/v1/repos/{owner}/{name}/issues` | Open one. Body: `title`, `body`, `labels`, `checks`. |
| `GET` | `/v1/repos/{owner}/{name}/issues/{number}` | An issue, its comments and its pull requests. |
| `PATCH` | `/v1/repos/{owner}/{name}/issues/{number}` | Change `title`, `body` or `labels`. |
| `POST` | `/v1/repos/{owner}/{name}/issues/{number}/close` | Close. Body: `reason`, `completed` or `not_planned`. |
| `POST` | `/v1/repos/{owner}/{name}/issues/{number}/reopen` | Reopen. |
| `POST` | `/v1/repos/{owner}/{name}/issues/{number}/comments` | Comment. Body: `body`. The number may be a pull request's. |
| `GET` | `/v1/repos/{owner}/{name}/labels` | The labels in use. |

```sh
curl -X POST https://api.g1t.sh/v1/repos/syntaqx/hello/issues \
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
| `GET` | `/v1/repos/{owner}/{name}/pulls?state=` | Pull requests, newest first. |
| `POST` | `/v1/repos/{owner}/{name}/pulls` | Open one. Body: `issue`, `title`, `agent`, and for a branch `branch`, `body`. |
| `GET` | `/v1/repos/{owner}/{name}/pulls/{number}` | A pull request, its comments and its issue. |
| `GET` | `/v1/repos/{owner}/{name}/pulls/{number}/changes` | The files it changes, with diffs. |
| `POST` | `/v1/repos/{owner}/{name}/pulls/{number}/ready` | Mark ready for review. Body: `summary`. |
| `POST` | `/v1/repos/{owner}/{name}/pulls/{number}/close` | Close without merging. |
| `POST` | `/v1/repos/{owner}/{name}/pulls/{number}/merge` | Land it on `main`. Body: `keep_issue_open`. Workspace members only; `409` if it is a draft or `main` has moved. |

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

## Sessions

| Method | Path | |
| --- | --- | --- |
| `GET` | `/v1/repos/{owner}/{name}/pulls/{number}/session?after=` | Entries after a sequence number. |
| `POST` | `/v1/repos/{owner}/{name}/pulls/{number}/session` | Append. Body: `entries`. |

```sh
curl -X POST https://api.g1t.sh/v1/repos/syntaqx/hello/pulls/14/session \
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
