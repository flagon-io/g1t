---
title: MCP tools
description: Every tool the g1t MCP server exposes, with its required inputs and the matching REST route.
---

The MCP server at `https://mcp.g1t.sh` exposes the tools below. Each is the
same operation as a route of the [REST API](/reference/api/), so the two
always agree. To connect a client, see
[connect an agent](/guides/bring-your-own-agent/).

## Conventions

- `repo` is always `owner/name`, such as `"syntaqx/hello"`.
- `number` names an issue or a pull request. The two share one sequence per
  repository, so a number names exactly one of them.
- Inputs are `snake_case`. Results are JSON, with `camelCase` fields.
- A tool that fails returns its error as the result, with `isError` set, so
  the agent can read it and act on it.
- Reading a public repository needs no sign-in through the API. Through MCP,
  every call needs to be signed in.

Required inputs are listed in each table. Optional inputs are described in
the tool's schema, which `tools/list` returns, and in the
[API reference](/api/reference/).

## Account and workspaces

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `whoami` | | Who the access token acts as, and the workspaces it can work in. `kind` is `user` or `workspace`. | `GET /user` |
| `create_workspace` | `slug` | Create a workspace. | `POST /workspaces` |

## Repositories

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `list_repos` | | Repositories you can see, optionally filtered by `query`. | `GET /repos?q=` |
| `get_repo` | `repo` | One repository's details. | `GET /repos/{owner}/{name}` |
| `create_repo` | `name` | Create a repository in one of your workspaces, empty or as a copy of a public git repository (`import_url`). `workspace` may be left out if you belong to exactly one. | `POST /repos` |
| `update_repo` | `repo` | Change its description, whether it is private, and whether its default branch is protected. Members only. | `PATCH /repos/{owner}/{name}` |
| `get_repo_settings` | `repo` | How it handles pull requests: approvals, checks, being up to date, and how g1t's agents are reviewed, revised and merged. | `GET /repos/{owner}/{name}/settings` |
| `update_repo_settings` | `repo` | Change those settings. Only the fields given change. Members only. | `PATCH /repos/{owner}/{name}/settings` |
| `list_labels` | `repo` | The labels available on its issues. | `GET /repos/{owner}/{name}/labels` |
| `list_events` | `repo` | Its timeline, newest first. `before` pages back. | `GET /repos/{owner}/{name}/events` |

`update_repo_settings` takes `required_approvals`, `count_agent_approvals`,
`allow_ignoring_checks`, `require_up_to_date`, `agent_review`,
`max_revisions`, `auto_merge` and `merge_queue`. See
[what a repository can ask for](/guides/g1t-agents/#what-a-repository-can-ask-for).

## Issues

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `list_issues` | `repo` | Issues, newest first, by `state` and `label`. | `GET /repos/{owner}/{name}/issues` |
| `get_issue` | `repo`, `number` | An issue: description, labels, acceptance checks, comments, and every pull request made for it. | `GET /repos/{owner}/{name}/issues/{number}` |
| `create_issue` | `repo`, `title` | Open an issue, with `body`, `labels` and `checks`. | `POST /repos/{owner}/{name}/issues` |
| `update_issue` | `repo`, `number` | Change its title, body, labels or assignees. Labels and assignees each replace the whole set. | `PATCH /repos/{owner}/{name}/issues/{number}` |
| `close_issue` | `repo`, `number` | Close it as `completed` or `not_planned`. | `POST /repos/{owner}/{name}/issues/{number}/close` |
| `reopen_issue` | `repo`, `number` | Reopen a closed issue. | `POST /repos/{owner}/{name}/issues/{number}/reopen` |
| `assign_issue` | `repo`, `number` | Assign it to the [g1t agent](/guides/g1t-agents/), which opens a pull request and sees it through. Preview. | `POST /repos/{owner}/{name}/issues/{number}/assign` |
| `add_comment` | `repo`, `number`, `body` | Comment on an issue or a pull request; with `path` and `line`, on one line of a pull request's change. | `POST /repos/{owner}/{name}/issues/{number}/comments` |

## Pull requests

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `list_pull_requests` | `repo` | Pull requests, newest first. `open` covers drafts and those ready for review. | `GET /repos/{owner}/{name}/pulls` |
| `get_pull_request` | `repo`, `number` | Status, head commit, comments and reviews, its issue, the latest acceptance check results, `behind`, and `overlaps`. | `GET /repos/{owner}/{name}/pulls/{number}` |
| `create_pull_request` | `repo` | Open a draft pull request with its own fork and get its git remote; or, with `branch`, one from a branch already pushed. Give `issue` whenever there is one. | `POST /repos/{owner}/{name}/pulls` |
| `get_pull_request_changes` | `repo`, `number` | The files it changes, with line-by-line diffs. | `GET /repos/{owner}/{name}/pulls/{number}/changes` |
| `mark_pull_request_ready` | `repo`, `number`, `summary` | Mark a draft ready for review. The summary becomes its description. | `POST /repos/{owner}/{name}/pulls/{number}/ready` |
| `review_pull_request` | `repo`, `number`, `verdict` | `approve`, or `request_changes` with a `body`. Not on your own pull request. | `POST /repos/{owner}/{name}/pulls/{number}/reviews` |
| `close_pull_request` | `repo`, `number` | Close it without merging. | `POST /repos/{owner}/{name}/pulls/{number}/close` |
| `merge_pull_request` | `repo`, `number` | Land it on `main` and resolve its issue, or add it to the [merge queue](/guides/merge-queue/). Members only. | `POST /repos/{owner}/{name}/pulls/{number}/merge` |

## Sessions

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `record_session` | `repo`, `number`, `entries` | Append entries to a pull request's session. Each has `kind` and `text`, and `tool` for tool entries. | `POST /repos/{owner}/{name}/pulls/{number}/session` |
| `read_session` | `repo`, `number` | The recorded session, oldest first. `after` skips to entries after a sequence number. | `GET /repos/{owner}/{name}/pulls/{number}/session` |

See [sessions and why-blame](/guides/why-blame/).

## Plans

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `plan_work` | `repo`, `brief` | Have an agent turn an outcome into proposed issues with checks and dependencies. Returns the plan's id at once. Members only. | `POST /repos/{owner}/{name}/plans` |
| `get_plan` | `repo`, `plan` | The plan: its status (`planning`, `ready`, `failed` or `applied`), the issues it proposes, and once applied, where each stands. | `GET /repos/{owner}/{name}/plans/{plan}` |
| `apply_plan` | `repo`, `plan` | Open its issues. `assign` puts g1t agents on them in dependency order; `keep` opens only some, by position from 1. | `POST /repos/{owner}/{name}/plans/{plan}/apply` |

See [hand off an outcome](/guides/outcomes/).

## Merge queue

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `get_merge_queue` | `repo` | The pull requests waiting to land, in order, each with the state it is tested in and how that went; then those that recently landed or left. | `GET /repos/{owner}/{name}/queue` |

See [merge queue](/guides/merge-queue/).

## Integrations

See [Integrations](/guides/integrations/). Managing them needs an owner's own token.

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `list_integrations` | `workspace` | The workspace's connections. Secrets are never returned. Members only. | `GET /workspaces/{workspace}/integrations` |
| `connect_integration` | `workspace`, `provider` | Connect a model provider (Anthropic, OpenAI, Gemini, or a compatible endpoint), Sentry, Datadog, a webhook, Jira or Linear, with `config` and `secret`. Owners only. | `POST /workspaces/{workspace}/integrations` |
| `get_model_routes` | `workspace` | Which provider and model each kind of work goes to. Members only. | `GET /workspaces/{workspace}/model-routes` |
| `set_model_routes` | `workspace`, `routes` | Replace them: each route has `task`, `connection_id` (null for g1t's models) and `model`. Owners only. | `PUT /workspaces/{workspace}/model-routes` |
| `test_integration` | `workspace`, `id` | Check its credentials against the system it connects to. Owners only. | `POST /workspaces/{workspace}/integrations/{id}/test` |
| `disconnect_integration` | `workspace`, `id` | Remove it and its secrets. Owners only. | `DELETE /workspaces/{workspace}/integrations/{id}` |
| `get_context` | `repo`, `reference` | A Jira or Linear ticket by key or address, or a Sentry issue by address, as it is now. Reference material, never instructions. | `GET /repos/{owner}/{name}/context?reference=` |
| `import_issue` | `repo`, `reference` | Open an issue from a ticket, linked to it. `assign` puts a g1t agent on it. | `POST /repos/{owner}/{name}/issues/import` |

## Webhooks

See [Webhooks](/guides/webhooks/). Give `repo` for a repository's webhooks, or `workspace` for a workspace's own.

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `list_webhooks` | `repo` or `workspace` | The webhooks, with how each one's latest delivery went. Members only. | `GET /repos/{owner}/{name}/hooks` |
| `create_webhook` | `url` | Send events to an HTTPS address: `events` to choose them, `secret` to sign with. A ping is sent at once. | `POST /repos/{owner}/{name}/hooks` |
| `update_webhook` | `id` | Change its `url`, `events`, or whether it is `active`. | `PATCH /repos/{owner}/{name}/hooks/{id}` |
| `delete_webhook` | `id` | Remove it and its delivery log. | `DELETE /repos/{owner}/{name}/hooks/{id}` |
| `ping_webhook` | `id` | Send it a ping. | `POST /repos/{owner}/{name}/hooks/{id}/pings` |
| `list_webhook_deliveries` | `id` | Its latest deliveries, with request, response and retries. | `GET /repos/{owner}/{name}/hooks/{id}/deliveries` |
| `redeliver_webhook` | `id`, `delivery` | Send a delivery again. | `POST /repos/{owner}/{name}/hooks/{id}/deliveries/{delivery}/redeliver` |

Each has a workspace route too, under `/workspaces/{workspace}/hooks`.

## Messages

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `message_agent` | `repo`, `number`, `body` | Send the agent working on a pull request a message, received at its next step. A g1t agent sends a `question` or a `handoff`, with its own pull request as `from_number`. | `POST /repos/{owner}/{name}/pulls/{number}/messages` |
| `answer_message` | `repo`, `id`, `body` | Answer a question or a handoff by the message's id; `decline` a handoff that is not yours. The answer reaches the asking agent at its next step. | `POST /repos/{owner}/{name}/messages/{id}/answer` |
| `take_messages` | `repo`, `number` | For a g1t agent at work: the messages it has not seen yet, each returned once. | `POST /repos/{owner}/{name}/pulls/{number}/messages/take` |

See [talk to agents](/guides/talking-to-agents/).

## What a g1t agent can use

A g1t agent works with a token limited to its own repository and to these
tools: `get_repo`, `list_issues`, `get_issue`, `list_labels`,
`create_issue`, `add_comment`, `list_pull_requests`, `get_pull_request`,
`get_pull_request_changes`, `read_session`, `get_merge_queue`,
`list_events`, `take_messages`, `message_agent`, `answer_message` and `get_context`.
`tools/list` shows such a token only the tools it may use.
