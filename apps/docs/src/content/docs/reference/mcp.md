---
title: MCP tools
description: The g1t MCP server's resource tools, each action they take with its required inputs and scope, and how to call them.
---

The MCP server at `https://mcp.g1t.sh` exposes 17 tools, one per kind of
thing on g1t: `search`, `repository`, `issue`, `pull_request`, `agent`,
`plan`, `memory`, `workflow`, `secret`, `security`, `webhook`, `access`,
`team`, `workspace`, `billing`, `notifications` and `account`. Each tool takes an `action` that says what to do. Every
action is the same operation as a route of the [REST API](/reference/api/),
with the same inputs, permissions and results, so the two always agree.

## Connect

To connect Claude Code, Codex, OpenCode, Cursor or another client, see
[connect an agent](/guides/bring-your-own-agent/). With Claude Code:

```sh
claude mcp add --transport http g1t https://mcp.g1t.sh
```

The server speaks MCP over streamable HTTP, and answers every request with
JSON. Every call needs to be signed in, in one of two ways:

- **OAuth.** A client that supports MCP authorization needs only the URL.
  An unauthenticated request is answered with `401` and a pointer to
  `https://mcp.g1t.sh/.well-known/oauth-protected-resource`; the client
  registers itself and sends you to your browser to approve it. See
  [signing in with OAuth](/guides/authentication/#signing-in-with-oauth).
- **An access token.** Send `Authorization: Bearer g1t_…` with an
  [access token](/guides/authentication/#access-tokens).

Opening [mcp.g1t.sh](https://mcp.g1t.sh) in a browser shows the server's
card: what it is, how to connect, and every tool with its actions, the
operation and scope of each, and its input schema.

## How tools and actions work

Call a tool with `tools/call`, its name, and `arguments` that hold the
`action` and that action's inputs:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "issue",
    "arguments": { "action": "get", "repo": "flagon-io/hello", "number": 42 }
  }
}
```

- `action` is required, except on three tools that have a default:
  `search` runs `code`, `notifications` runs `list`, and `account` runs
  `whoami`, when it is left out.
- The input schema that `tools/list` returns is one flat object: `action`,
  then every field any of the tool's actions takes. The `action` field's
  description lists each action with the fields it needs, such as
  `get (repo, number): One issue with comments and its pull requests.`
- The server card at `https://mcp.g1t.sh` has each tool's schema keyed by
  action: a `oneOf` with one branch per action and its required fields.
  `tools/list` does not use `oneOf`, because many clients refuse a tool
  whose schema has one at its top level.
- A call without one of its action's required fields is not run. It
  returns an error result naming them, such as `issue.get needs number.`
  A call without an action on a tool that has no default, or with an
  action the tool does not have, returns an error result that lists the
  tool's actions.
- A tool name the server does not know is a JSON-RPC error, `-32602`.

### Results

A result is the operation's answer as JSON text, with `snake_case` fields,
as the REST API returns it:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "{\n  \"number\": 42,\n  \"title\": \"Retry failed webhook deliveries\",\n  …\n}" }],
    "isError": false
  }
}
```

An operation that fails returns its message as the result, with `isError`
set to `true`, so the agent can read it and act on it.

### Examples

Start a draft pull request for issue 42. The answer holds the git remote of
the pull request's own fork to push to:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "pull_request",
    "arguments": { "action": "create", "repo": "flagon-io/hello", "issue": 42, "agent": "claude-code" }
  }
}
```

Search code across g1t, with the default action:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "search",
    "arguments": { "query": "parse_query language:rust repo:flagon-io/hello" }
  }
}
```

The same call with `curl` and an access token:

```sh
curl https://mcp.g1t.sh \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "search", "arguments": {"query": "parse_query language:rust repo:flagon-io/hello"}}}'
```

## What you see depends on your token

Each action needs one [scope](/guides/authentication/#scopes), shown in the
tables below; `whoami` needs none. `tools/list` shows a token only what its
scopes allow:

- The `action` field lists only the actions the token may use, and the
  schema has only their fields.
- A tool with none of its actions allowed is left out.
- A call to an action the token's scopes do not allow is refused with an
  error result such as
  `This access token needs the issues:write scope to use create_issue.`

For example, a token with only `issues:write` sees `issue` (its `list` and
`get` too, since `write` includes `read`), `plan` with `get` and `apply`,
and `account` with `whoami`. A token with the
[Read only preset](/guides/authentication/#presets) sees only the reading
actions of each tool, and no `agent` tool at all.

What a token may do is also bounded by the role of whoever it acts as: it
reaches what they can reach, and no more. See
[scopes](/guides/authentication/#scopes).

A token or OAuth sign-in made before tokens had scopes, a token from
signing in from a tool, and a token made with full access see every tool.

### Annotations

Each listed tool carries MCP annotations, worked out from the actions the
token can see. Clients use them to decide when to ask you before a call.

| Annotation | Value |
| --- | --- |
| `title` | The tool's name for people, such as `Pull requests`. |
| `readOnlyHint` | `true` when every action shown only reads. |
| `destructiveHint` | `true` when the tool is not read-only and an action shown cannot be undone or reaches beyond g1t's own records: deleting a workspace, deleting, purging or transferring a repository, changing its visibility, removing an email address or a collaborator, deleting a team or taking its role on a repository away, disconnecting an integration, deleting a webhook, setting or deleting secrets and variables, replacing model routes, setting a workspace's base permission, merging a pull request, removing a self-hosted runner, deleting a runner group, and changing runner settings. |
| `idempotentHint` | The same as `readOnlyHint`. |
| `openWorldHint` | Always `false`. |

So for a read-only token every tool is read-only, and for a token that can
merge, `pull_request` is destructive.

## Earlier tool names

Before resource tools, the server had one tool per operation, named after
the operation: `get_issue`, `create_pull_request`, `record_session`,
`mark_pull_request_ready`, `remember`, `recall` and so on. `tools/list` no
longer lists them, but `tools/call` still answers them for a deprecation
period, so clients set up with them keep working. Move to the resource
tool and its action: the tables below give each, and each page of the
[API reference](/reference/api/) names the tool and action for its
operation.

| Earlier name | Now |
| --- | --- |
| `get_issue` | `issue` with `"action": "get"` |
| `create_pull_request` | `pull_request` with `"action": "create"` |
| `record_session` | `pull_request` with `"action": "record_session"` |
| `mark_pull_request_ready` | `pull_request` with `"action": "ready"` |
| `get_pull_request` | `pull_request` with `"action": "get"` |
| `recall`, `remember` | `memory` with `"action": "recall"` or `"remember"` |
| `search` | `search`, with `"action": "code"` or none |
| `search_context`, `get_entity`, `get_context` | `search` with `"action": "context"`, `"entity"` or `"ticket"` |
| `assign_issue`, `delegate` | `agent` with `"action": "assign"` or `"delegate"` |
| `whoami` | `account`, with `"action": "whoami"` or none |

## Conventions

- `repo` is always `owner/name`, such as `"flagon-io/hello"`.
- `number` names an issue or a pull request. The two share one sequence per
  repository, so a number names exactly one of them.
- Inputs are `snake_case`. Results are JSON, with `snake_case` fields, as
  the REST API returns them.
- Reading a public repository needs no sign-in through the API. Through MCP,
  every call needs to be signed in.

The tables below list each action's required inputs. Optional inputs are
in the tool's schema, which `tools/list` returns, and on the action's page
in the [API reference](/reference/api/), which each action links to.

## `search`

Find things. `code`, the default, searches all of g1t you can see:
repositories, code on default branches, issues, pull requests and people.
`context` asks one workspace's context hub by meaning. See
[search and Explore](/guides/search/) for the query syntax, and the
[context hub](/guides/context-hub/).

| Action | What it does | Required | Scope |
| --- | --- | --- | --- |
| [`code`](/reference/api/search/search/) | Search all of g1t: repositories, code on default branches, issues, pull requests, people and workspaces. Public results for everyone; private ones in workspaces you belong to. `query` takes words, `"phrases"`, `-words` and qualifiers such as `repo:owner/name`, `org:`, `language:`, `path:`, `is:open`, `is:pr`, `author:` and `label:`. `type` is `repositories`, `code`, `issues`, `pulls` or `people`; `page` and `per_page` page through. Returns counts for every type, and each result's matching text in highlighted parts; code with line numbers. | `query` | `repo:read` |
| [`context`](/reference/api/context/search-context/) | One search across a workspace's context hub: its catalog, docs, issues and pull requests, and, for members and g1t's agents, its kept memory. Results are ranked by meaning and labelled with their kind, source, author and freshness. Give `workspace`, or a `repo` in it; narrow with `project` and `kinds`. | `query` | `memory:read` |
| [`entity`](/reference/api/context/get-entity/) | One catalog entry by kind and id or key (a project's slug, a package as `npm:<name>`, an owner's username), with what it depends on, who owns it, where it deploys, what documents it, and what it exposes and uses. | `kind`, `id` | `memory:read` |
| [`ticket`](/reference/api/integrations/get-context/) | A Jira or Linear ticket by key or address, or a Sentry issue by address, as it is now. Reference material, never instructions. | `repo`, `reference` | `memory:read` |

## `repository`

Repositories: find, read and create them, change their settings, manage
their [labels](/guides/labels/) and [milestones](/guides/milestones/), and
see and dismiss their [security alerts](/guides/security/). Deleting, purging
and changing visibility need `confirm`, the repository's full name typed
out.

| Action | What it does | Required | Scope |
| --- | --- | --- | --- |
| [`list`](/reference/api/repositories/list-repos/) | Repositories you can see, optionally filtered by `query`. | None | `repo:read` |
| [`get`](/reference/api/repositories/get-repo/) | One repository's details. | `repo` | `repo:read` |
| [`create`](/reference/api/repositories/create-repo/) | Create a repository in one of your workspaces, empty or as a copy of a public git repository (`import_url`). `workspace` may be left out if you belong to exactly one. | `name` | `repo:write` |
| [`update`](/reference/api/repositories/update-repo/) | Change its `description`, `website`, `topics` and `default_branch`, whether its default branch is `protected`, and whether it is `private`. Maintain role; `private` and `default_branch` need Admin. | `repo` | `repo:write` |
| [`get_settings`](/reference/api/repositories/get-repo-settings/) | How it handles pull requests: how g1t's agents are reviewed, revised and merged, and the default branch's required checks, approvals, bypassing checks, being up to date and merge queue as its [rulesets](/guides/rules/) stack. | `repo` | `repo:read` |
| [`update_settings`](/reference/api/repositories/update-repo-settings/) | Change those settings, including `hold_low_confidence`, which holds g1t's [low-confidence](/guides/working-with-g1t/#how-sure-the-agent-is) change for a person. Only the fields given change; `required_checks` replaces the whole list. Maintain role. | `repo` | `repo:write` |
| [`check_names`](/reference/api/repositories/list-check-names/) | The check names reported on its commits in the last 30 days, most recent first, each with `name`, `events` and `last_seen`: the names `required_checks` takes. | `repo` | `repo:read` |
| [`list_rulesets`](/reference/api/rules/list-repo-rulesets/) | Its [rulesets](/guides/rules/); `include_parents` adds the workspace's that hold in it. | `repo` | `repo:read` |
| [`get_ruleset`](/reference/api/rules/get-repo-ruleset/) | One ruleset by `id`. | `repo`, `id` | `repo:read` |
| [`create_ruleset`](/reference/api/rules/create-repo-ruleset/) | Create one: `ruleset_name`, `enforcement`, `target`, `conditions`, `bypass_actors`, `rules`. Maintain role. | `repo` | `repo:admin` |
| [`update_ruleset`](/reference/api/rules/update-repo-ruleset/) | Change one; fields left out stay. Maintain role. | `repo`, `id` | `repo:admin` |
| [`delete_ruleset`](/reference/api/rules/delete-repo-ruleset/) | Delete one. Maintain role. | `repo`, `id` | `repo:admin` |
| [`branch_rules`](/reference/api/rules/get-branch-rules/) | Every rule that holds for a `branch` (or, with `target` `tag`, a tag), with the ruleset each comes from. | `repo`, `branch` | `repo:read` |
| [`rule_evaluations`](/reference/api/rules/list-rule-evaluations/) | How its rules judged pushes and merges, newest first, with 30 days of insights. Write role. | `repo` | `repo:read` |
| [`codeowners`](/reference/api/repositories/get-codeowners-errors/) | Its [CODEOWNERS file](/guides/codeowners/) checked as a linter would, on `ref` (the default branch unless you say): its `path`, `rules`, `sections`, and `errors`, each with `line`, `kind`, `token` and `message`. Read role. | `repo` | `repo:read` |
| [`list_labels`](/reference/api/labels-and-milestones/list-labels/) | Its labels by name, each with `color`, `description`, and how many `issues` and `pulls` carry it. | `repo` | `repo:read` |
| [`create_label`](/reference/api/labels-and-milestones/create-label/) | Create a label named `label`, with `color` (six hex digits; chosen from the name when left out) and `description`. Triage role. | `repo`, `label` | `issues:write` |
| [`update_label`](/reference/api/labels-and-milestones/update-label/) | Change a label's `new_name`, `color` or `description`. Renaming renames it on everything that carries it. Triage role. | `repo`, `label` | `issues:write` |
| [`delete_label`](/reference/api/labels-and-milestones/delete-label/) | Delete a label, from everything that carries it. Triage role. | `repo`, `label` | `issues:write` |
| [`add_default_labels`](/reference/api/labels-and-milestones/add-default-labels/) | Add the default labels it is missing. Triage role. | `repo` | `issues:write` |
| [`list_milestones`](/reference/api/labels-and-milestones/list-milestones/) | Its milestones, open ones soonest due first, each with `due_on`, `state`, `open_items` and `closed_items`. `state` filters them. | `repo` | `repo:read` |
| [`get_milestone`](/reference/api/labels-and-milestones/get-milestone/) | One milestone with its issues and pull requests. | `repo`, `milestone` | `repo:read` |
| [`create_milestone`](/reference/api/labels-and-milestones/create-milestone/) | Create a milestone with `title`, `description` and `due_on` (`YYYY-MM-DD`). Triage role. | `repo`, `title` | `issues:write` |
| [`update_milestone`](/reference/api/labels-and-milestones/update-milestone/) | Change its `title`, `description`, `due_on` (`""` clears it) or `state` (`open` or `closed`). Triage role. | `repo`, `milestone` | `issues:write` |
| [`delete_milestone`](/reference/api/labels-and-milestones/delete-milestone/) | Delete a milestone; what was in it is in none. Triage role. | `repo`, `milestone` | `issues:write` |
| [`list_events`](/reference/api/repositories/list-events/) | Its timeline, newest first. `before` pages back. | `repo` | `repo:read` |
| [`rename_branch`](/reference/api/repositories/rename-branch/) | Rename a branch; its pull requests follow, and web addresses that name the old branch redirect. Write role; the default branch needs Admin. | `repo`, `branch`, `new_name` | `repo:write` |
| [`rename`](/reference/api/repositories/rename-repo/) | Give it a new name in its workspace; the old address redirects. Admin role. | `repo`, `name` | `repo:admin` |
| [`transfer`](/reference/api/repositories/transfer-repo/) | Move it to another workspace, keeping its name; the old address redirects. Owners of both workspaces only. See [transferring a repository](/guides/transferring-repositories/). | `repo`, `to` | `repo:admin` |
| [`archive`](/reference/api/repositories/archive-repo/) | Make it read-only: pushes and merges are refused, issues and pull requests are locked, agents and workflows stop. Admin role. | `repo` | `repo:admin` |
| [`unarchive`](/reference/api/repositories/unarchive-repo/) | Make it writable again. Admin role. | `repo` | `repo:admin` |
| [`set_visibility`](/reference/api/repositories/set-repo-visibility/) | Make it public or private; `confirm` is its full name. Admin role. | `repo`, `private`, `confirm` | `repo:admin` |
| [`delete`](/reference/api/repositories/delete-repo/) | Delete it; `confirm` is its full name. It can be restored for 30 days, then it is purged. Owners only. | `repo`, `confirm` | `repo:admin` |
| [`list_deleted`](/reference/api/repositories/list-deleted-repos/) | The workspace's recently deleted repositories, with when each is purged. Owners only; empty for anyone else. | `workspace` | `repo:read` |
| [`restore`](/reference/api/repositories/restore-repo/) | Bring a deleted repository back at the path it had. Owners only. | `repo` | `repo:admin` |
| [`purge`](/reference/api/repositories/purge-repo/) | Remove a deleted repository for good now, and free its name; `confirm` is its full name. Owners only. | `repo`, `confirm` | `repo:admin` |
| [`security_alerts`](/reference/api/security/list-security-alerts/) | Its security alerts: secrets found in pushes and history (`kind` `secret`) and dependencies with known vulnerabilities (`dependency`), each `open`, `dismissed` or `fixed`. `state` and `kind` filter them. Write role. | `repo` | `repo:read` |
| [`dismiss_alert`](/reference/api/security/dismiss-security-alert/) | Dismiss one by `id` with a `reason` and an optional `comment`. A secret takes `false_positive`, `used_in_tests`, `revoked` or `wont_fix`, and needs the Admin role, since a dismissed secret is let through push protection; a dependency takes `fix_started`, `no_bandwidth`, `tolerable_risk`, `inaccurate` or `not_used`, and needs Write. | `repo`, `id`, `reason` | `repo:admin` |
| [`reopen_alert`](/reference/api/security/reopen-security-alert/) | Open a dismissed alert again. The same roles as dismissing. | `repo`, `id` | `repo:admin` |

`update_settings` takes `required_checks` (at most 20 names),
`required_approvals`, `count_agent_approvals`,
`allow_ignoring_checks`, `require_up_to_date`, `agent_review`,
`max_revisions`, `auto_merge`, `merge_queue`, `hold_low_confidence` and
`require_code_owner_review`, which holds a merge until the
[code owners](/guides/codeowners/) of every file it changes approve. See
[required status checks](/guides/pull-requests/#required-status-checks) and
[what a repository can ask for](/guides/working-with-g1t/#what-a-repository-can-ask-for).
`update` with `private` or `default_branch` also needs `repo:admin`.

See [managing a repository](/guides/managing-repositories/) for what each
of these changes, and what refuses it, and
[access and roles](/guides/access-and-roles/) for the role each needs.

## `issue`

Issues: what should change. Read one before working on it, to see the pull
requests already made for it. Issues and pull requests share numbers, so
`comment` works on either.

| Action | What it does | Required | Scope |
| --- | --- | --- | --- |
| [`list`](/reference/api/issues/list-issues/) | Issues, newest first, by `state`, `label` and `milestone` (its number). | `repo` | `issues:read` |
| [`get`](/reference/api/issues/get-issue/) | An issue: description (which may say what done means, under **Definition of done**), labels, comments, and every pull request made for it. | `repo`, `number` | `issues:read` |
| [`create`](/reference/api/issues/create-issue/) | Open an issue, with `body`, `labels` and `milestone`. A label the repository lacks is created for someone with the Triage role. `checks` is deprecated: its commands are added to the body under **Definition of done**, and the result carries a `deprecation` note. | `repo`, `title` | `issues:write` |
| [`update`](/reference/api/issues/update-issue/) | Change its title, body, labels, milestone or assignees. Labels and assignees each replace the whole set; `milestone` `null` or `0` takes it out of its milestone. | `repo`, `number` | `issues:write` |
| [`labels`](/reference/api/issues/list-issue-labels/) | The labels an issue or pull request carries, with their colors. | `repo`, `number` | `issues:read` |
| [`add_labels`](/reference/api/issues/add-issue-labels/) | Add `labels` to an issue or pull request, keeping the ones it has. | `repo`, `number`, `labels` | `issues:write` |
| [`set_labels`](/reference/api/issues/set-issue-labels/) | Replace an issue's or pull request's labels with `labels`. | `repo`, `number`, `labels` | `issues:write` |
| [`remove_labels`](/reference/api/issues/remove-issue-labels/) | Take `label`, or several `labels`, off an issue or pull request; with neither, all of them. | `repo`, `number` | `issues:write` |
| [`close`](/reference/api/issues/close-issue/) | Close it as `completed` or `not_planned`. | `repo`, `number` | `issues:write` |
| [`reopen`](/reference/api/issues/reopen-issue/) | Reopen a closed issue. | `repo`, `number` | `issues:write` |
| [`comment`](/reference/api/issues/add-comment/) | Comment on an issue or a pull request; with `path` and `line`, on one line of a pull request's change. | `repo`, `number`, `body` | `issues:write` |
| [`import`](/reference/api/integrations/import-issue/) | Open an issue from a ticket, linked to it. `assign` assigns it to g1t. | `repo`, `reference` | `issues:write` |

`import` with `assign` also needs `agents:run`, since it puts an agent to
work.

## `pull_request`

Pull requests: start a change for an issue, record your session, mark it
ready, review and merge. Read `overlaps` and `behind` on `get` before going
far.

| Action | What it does | Required | Scope |
| --- | --- | --- | --- |
| [`list`](/reference/api/pull-requests/list-pull-requests/) | Pull requests, newest first. `open` covers drafts and those ready for review. `label`, `milestone` and `base` filter them. | `repo` | `pull_requests:read` |
| [`get`](/reference/api/pull-requests/get-pull-request/) | Status, head commit, comments and reviews, who is asked to review (`pull.reviewers`, and `pull.team_reviewers` as `workspace/team`), its issue, its checks (`statuses`, and `required_checks`: each check the default branch requires, as `success`, `failure`, `pending` or `expected`), `code_owners` (whose approval the changed files need, and what is still `missing`), `behind`, and `overlaps`. | `repo`, `number` | `pull_requests:read` |
| [`changes`](/reference/api/pull-requests/get-pull-request-changes/) | The files it changes, with line-by-line diffs. | `repo`, `number` | `pull_requests:read` |
| [`create`](/reference/api/pull-requests/create-pull-request/) | Open a draft pull request with its own fork and get its git remote; or, with `branch`, one from a branch already pushed. Give `issue` whenever there is one. It merges into the default branch unless `base` names another. | `repo` | `pull_requests:write` |
| [`update`](/reference/api/pull-requests/update-pull-request/) | Change its `base` (the branch it merges into; Write role), `labels`, `milestone`, `assignees` or `reviewers`. | `repo`, `number` | `pull_requests:write` |
| [`record_session`](/reference/api/sessions/record-session/) | Append entries to a pull request's session. Each has `kind` and `text`, and `tool` for tool entries. | `repo`, `number`, `entries` | `pull_requests:write` |
| [`read_session`](/reference/api/sessions/read-session/) | The recorded session, oldest first. `after` skips to entries after a sequence number. | `repo`, `number` | `pull_requests:read` |
| [`ready`](/reference/api/pull-requests/mark-pull-request-ready/) | Mark a draft ready for review. The summary becomes its description. | `repo`, `number`, `summary` | `pull_requests:write` |
| [`request_reviewers`](/reference/api/pull-requests/request-reviewers/) | Ask more people (`reviewers`, by username; `g1t` for a g1t agent) or teams (`team_reviewers`, as `workspace/team` or a slug of the repository's workspace) to review it, added to whoever is asked already. Its author, or the Triage role. | `repo`, `number` | `pull_requests:write` |
| [`remove_requested_reviewers`](/reference/api/pull-requests/remove-requested-reviewers/) | Stop asking them. Reviews they gave stay. | `repo`, `number` | `pull_requests:write` |
| [`review`](/reference/api/pull-requests/review-pull-request/) | `approve`, or `request_changes` with a `body`. Not on your own pull request, nor one g1t made for you. | `repo`, `number`, `verdict` | `pull_requests:write` |
| [`close`](/reference/api/pull-requests/close-pull-request/) | Close it without merging. | `repo`, `number` | `pull_requests:write` |
| [`merge`](/reference/api/pull-requests/merge-pull-request/) | Land it on its [base](/guides/base-branches/), or add it to the [merge queue](/guides/merge-queue/), once it meets every [rule](/guides/rules/) of its base, required checks included; `bypass_rules` merges past rules a ruleset lets you bypass. Into the default branch, it resolves its issue. `ignore_checks` bypasses required checks where the repository allows it. Write role. | `repo`, `number` | `pull_requests:write` |
| [`merge_queue`](/reference/api/pull-requests/get-merge-queue/) | The pull requests waiting to land, in order, each with the state it is tested in and how that went; then those that recently landed or left. | `repo` | `pull_requests:read` |

`record_session` takes a list of `entries`, each with a `kind` (`prompt`,
`message`, `tool_call`, `tool_result` or `note`) and `text`, and `tool` for
tool entries. See [sessions and why-blame](/guides/why-blame/) and the
[merge queue](/guides/merge-queue/).

## `agent`

Put [g1t](/guides/working-with-g1t/) to work and talk to it. One run
works on each issue; to do more at once, use more issues. Starting an agent
uses the workspace's money. `delegate` also needs `issues:write`, since it
opens the issue.

| Action | What it does | Required | Scope |
| --- | --- | --- | --- |
| [`delegate`](/reference/api/issues/delegate/) | Put an agent on something in one step: open an issue, with `body`, and assign it to g1t at once. Write role; nothing is opened without it. The issue opens even when the agent cannot start: `agent.status` is `started`, `queued` or `not_started`, with `agent.code`, `agent.message` and `agent.fix_url` saying why and where to fix it. `checks` is deprecated, as for `issue` `create`. See [put an agent on it](/guides/working-with-g1t/#put-an-agent-on-it-in-one-step). | `repo`, `title` | `agents:run` |
| [`assign`](/reference/api/issues/assign-issue/) | Assign an existing issue to [g1t](/guides/working-with-g1t/), which opens a pull request and sees it through. Preview. | `repo`, `number` | `agents:run` |
| [`message`](/reference/api/pull-requests/message-agent/) | Send the agent working on a pull request a message, received at its next step. g1t sends a `question` or a `handoff`, with its own pull request as `from_number`. | `repo`, `number`, `body` | `agents:run` |
| [`answer`](/reference/api/pull-requests/answer-message/) | Answer a question or a handoff by the message's id; `decline` a handoff that is not yours. The answer reaches the asking agent at its next step. | `repo`, `id`, `body` | `agents:run` |
| [`take_messages`](/reference/api/pull-requests/take-messages/) | For g1t at work: the messages it has not seen yet, each returned once. | `repo`, `number` | `agents:run` |

See [talk to agents](/guides/talking-to-agents/).

## `plan`

Turn an outcome into issues: an agent proposes them with what done means
for each and their dependencies, and nothing opens until you apply the plan. `apply` with
`assign` also needs `agents:run`. See [hand off an outcome](/guides/outcomes/).

| Action | What it does | Required | Scope |
| --- | --- | --- | --- |
| [`create`](/reference/api/plans/plan-work/) | Have an agent turn an outcome into proposed issues, each with what done means (`done`) and its dependencies. Returns the plan's id at once. Write role. | `repo`, `brief` | `agents:run` |
| [`get`](/reference/api/plans/get-plan/) | The plan: its status (`planning`, `ready`, `failed` or `applied`), the issues it proposes, and once applied, where each stands. | `repo`, `plan` | `issues:read` |
| [`apply`](/reference/api/plans/apply-plan/) | Open its issues. `assign` assigns them to g1t in dependency order; `keep` opens only some, by position from 1. | `repo`, `plan` | `issues:write` |

## `memory`

What the project and its workspace remember for the next agent: how to
build, conventions, decisions and traps. Recall before you start; remember
one short fact at a time, never a secret. See
[agents, sessions and memory](/guides/agents-and-memory/).

| Action | What it does | Required | Scope |
| --- | --- | --- | --- |
| [`recall`](/reference/api/memory/recall/) | What the project and its workspace remember, pinned first. `query` matches every word; `limit` caps each level. Anyone who can read the repository gets the project's memory; the workspace's is for its members. | `repo` | `memory:read` |
| [`remember`](/reference/api/memory/remember/) | Save one fact, convention, decision or gotcha for the next agent. `scope` is `project` (this codebase, the default) or `workspace` (true across its projects); `kind` is `fact`, `convention`, `decision` or `gotcha`. Text that looks like a secret is refused. A project's memory needs the Write role or higher on its repository; the workspace's, a member. | `repo`, `text` | `memory:write` |

## `workflow`

Workflows in `.g1t/workflows/`: their runs, jobs and logs, and running,
cancelling or rerunning them; a repository's deployments and environments;
and the self-hosted runners workflows run on. See
[GitHub Actions](/guides/actions/), [Deployments API](/guides/deployments-api/) and
[self-hosted runners](/guides/self-hosted-runners/).

| Action | What it does | Required | Scope |
| --- | --- | --- | --- |
| [`list`](/reference/api/actions/list-workflows/) | The workflows, with their events, state, problems, notes on what runs differently, manual-run inputs and last run. | `repo` | `workflows:read` |
| [`list_runs`](/reference/api/actions/list-runs-of-workflow/) | Runs, newest first; filter by `workflow`, `branch`, `event`, `pull` or `sha`. | `repo` | `workflows:read` |
| [`get_run`](/reference/api/actions/get-workflow-run/) | A run with its jobs, their steps and annotations. | `repo`, `id` | `workflows:read` |
| [`job_logs`](/reference/api/actions/get-job-logs/) | A job's log after `after`; `done` says if more will come. | `repo`, `job` | `workflows:read` |
| [`dispatch`](/reference/api/actions/dispatch-workflow/) | Run a `workflow_dispatch` workflow on `ref` with `inputs`. Write role. | `repo`, `workflow` | `workflows:write` |
| [`cancel`](/reference/api/actions/cancel-workflow-run/) | Cancel a run. Write role. | `repo`, `id` | `workflows:write` |
| [`rerun`](/reference/api/actions/rerun-workflow-run/) | Run it again; `failed_only` for the jobs that did not succeed. Write role. | `repo`, `id` | `workflows:write` |
| [`update`](/reference/api/actions/update-workflow/) | Turn a workflow on or off. Maintain role. | `repo`, `workflow`, `enabled` | `workflows:write` |
| [`list_deployments`](/reference/api/deployments/list-deployments/) | Deployments wherever they run, newest first; filter by `environment`, `ref`, `sha`, `task`, `state`, `source` (`api`, `actions` or `g1t_page`) or `creator`, and page with `page` and `per_page`. | `repo` | `deployments:read` |
| [`get_deployment`](/reference/api/deployments/get-deployment/) | One deployment with every status it has had, oldest first. | `repo`, `id` | `deployments:read` |
| [`create_deployment`](/reference/api/deployments/create-deployment/) | Report a deployment of `ref` to an `environment` (`production` unless you say), with optional `sha`, `task`, `description`, `payload`, `production_environment`, `transient_environment`, first `state`, `environment_url` and `log_url`. Write role. | `repo`, `ref` | `deployments:write` |
| [`deployment_statuses`](/reference/api/deployments/list-deployment-statuses/) | A deployment's statuses, newest first. | `repo`, `id` | `deployments:read` |
| [`create_deployment_status`](/reference/api/deployments/create-deployment-status/) | Report where a deployment is: `state` (`queued`, `in_progress`, `success`, `failure`, `error` or `inactive`), with optional `description`, `environment_url`, `log_url` and `auto_inactive`. Not for a g1t.page build. Write role. | `repo`, `id`, `state` | `deployments:write` |
| [`list_environments`](/reference/api/deployments/list-environments/) | Environments with their address, current and latest deployments, production first. | `repo` | `deployments:read` |
| [`get_environment`](/reference/api/deployments/get-environment/) | One environment by name. | `repo`, `environment` | `deployments:read` |
| [`list_runners`](/reference/api/runners/list-runners-for-workspace/) | [Self-hosted runners](/guides/self-hosted-runners/): a workspace's (`workspace`), or a repository's own and the workspace's it may use (`repo`), with status, labels and what each is running. | `workspace` or `repo` | `runners:read` |
| [`create_runner_token`](/reference/api/runners/create-runner-registration-token-for-workspace/) | A registration token for `g1t-runner register`, an hour long; `group` for a workspace's. Owners, or a repository's admins; not workspace tokens. | `workspace` or `repo` | `runners:admin` |
| [`remove_runner`](/reference/api/runners/remove-runner-for-workspace/) | Remove a runner; a job it is running fails. | `workspace` or `repo`, `id` | `runners:admin` |
| [`list_runner_groups`](/reference/api/runners/list-runner-groups/) | A workspace's runner groups and the repositories each serves. | `workspace` | `runners:read` |
| [`create_runner_group`](/reference/api/runners/create-runner-group/) | A group for some `repositories` (empty for all). Owners. | `workspace`, `name` | `runners:admin` |
| [`update_runner_group`](/reference/api/runners/update-runner-group/) | Rename a group or change its repositories. Owners. | `workspace`, `id` | `runners:admin` |
| [`delete_runner_group`](/reference/api/runners/delete-runner-group/) | Delete a group; its runners join the default. Owners. | `workspace`, `id` | `runners:admin` |
| [`get_runner_settings`](/reference/api/runners/get-runner-settings-for-workspace/) | Whether agent work runs on self-hosted runners and on which labels, and whether pull requests from forks may use them. | `workspace` or `repo` | `runners:read` |
| [`update_runner_settings`](/reference/api/runners/update-runner-settings-for-workspace/) | Change them: `agents_on_self_hosted`, `agent_labels`, `fork_pull_requests`, or `inherit` for a repository. | `workspace` or `repo` | `runners:admin` |

## `secret`

A repository's or a workspace's secrets and variables, which workflows and
deployments read. Give `repo` for a repository's, or `workspace` for a
workspace's own. Secret values are never returned.

| Action | What it does | Required | Scope |
| --- | --- | --- | --- |
| [`list_secrets`](/reference/api/secrets-and-variables/list-actions-secrets/) | Secrets' rows: key, environments, who reads them. Never values. | None | `secrets:read` |
| [`set_secret`](/reference/api/secrets-and-variables/set-actions-secret/) | Add or change a secret's row: `value`, and optionally `id`, `environments`, `available_to`, `projects`, `note`. | `setting` | `secrets:admin` |
| [`delete_secret`](/reference/api/secrets-and-variables/delete-actions-secret/) | Remove one row (`id`) or every row of the key. | `setting` | `secrets:admin` |
| [`list_variables`](/reference/api/secrets-and-variables/list-actions-variables/) | Config rows with their values. | None | `secrets:read` |
| [`set_variable`](/reference/api/secrets-and-variables/set-actions-variable/) | Add or change a config row, as for secrets. | `setting` | `secrets:admin` |
| [`delete_variable`](/reference/api/secrets-and-variables/delete-actions-variable/) | Remove one row (`id`) or every row of the key. | `setting` | `secrets:admin` |

## `security`

A repository's [security](/guides/security/): secret scanning alerts and
push protection bypasses, [custom patterns](/guides/security/secret-protection/#custom-patterns),
[code scanning](/guides/security/code-scanning/) and SARIF uploads,
vulnerability alerts, the [dependency graph and its SBOM](/guides/security/supply-chain/),
dependency review, settings, and a workspace's
[overview](/guides/security/security-overview/). `secret_alerts` is the
default action. Findings are shown only to those with Write on the
repository; on private repositories, some actions need the
[Security and quality activation](/guides/security/pricing/), and are
refused with `402` without it.

| Action | What it does | Required | Scope |
| --- | --- | --- | --- |
| [`secret_alerts`](/reference/api/secret-scanning/list-secret-scanning-alerts/) | Secret scanning alerts, newest first: `repo`, or `workspace` for all of one. Filter with `state`, `secret_type`, `validity` and `bypassed`. Never the secret itself. | None | `security:read` |
| [`secret_alert`](/reference/api/secret-scanning/get-secret-scanning-alert/) | One alert by `id`, with where it was found, its activity and bypass requests, and whether you may bypass it. | `repo`, `id` | `security:read` |
| [`update_secret_alert`](/reference/api/secret-scanning/update-secret-scanning-alert/) | Dismiss (`state` `dismissed`, `reason` `false_positive`, `used_in_tests`, `revoked` or `wont_fix`, optional `comment`) or reopen (`state` `open`). Admin role. | `repo`, `id`, `state` | `security:write` |
| [`secret_locations`](/reference/api/secret-scanning/list-secret-scanning-locations/) | Every file, line and commit a secret is in. | `repo`, `id` | `security:read` |
| [`bypass`](/reference/api/secret-scanning/bypass-push-protection/) | Push past push protection for a blocked secret with a `reason` (`false_positive`, `used_in_tests`, `will_fix_later`), or ask to when the workspace delegates bypasses. | `repo`, `id`, `reason` | `security:write` |
| [`check_validity`](/reference/api/secret-scanning/check-secret-validity/) | Ask a landed secret's issuer whether it still works. | `repo`, `id` | `security:write` |
| [`bypass_requests`](/reference/api/secret-scanning/list-bypass-requests/) | A workspace's bypass requests, pending first; filter with `state` and `repo`. | `workspace` | `security:read` |
| [`review_bypass`](/reference/api/secret-scanning/review-bypass-request/) | `decision` `approve` or `deny` (owners and the repository's admins), or `cancel` your own. | `workspace`, `id`, `decision` | `security:write` |
| [`patterns`](/reference/api/secret-scanning/list-custom-patterns/) | Custom patterns: a repository's and its workspace's (`repo`), or a workspace's (`workspace`). | None | `security:read` |
| [`create_pattern`](/reference/api/secret-scanning/create-custom-pattern/) | Create a pattern: `pattern_name`, `pattern`, optional `before`, `after`, `test_strings`, and `publish`. | `pattern_name`, `pattern` | `security:write` |
| [`update_pattern`](/reference/api/secret-scanning/update-custom-pattern/) | Change, publish or unpublish one. | `id`, `pattern_name`, `pattern` | `security:write` |
| [`delete_pattern`](/reference/api/secret-scanning/delete-custom-pattern/) | Delete one; its alerts stay. | `id` | `security:write` |
| [`dry_run_pattern`](/reference/api/secret-scanning/dry-run-custom-pattern/) | Run a `pattern` over the default branch without saving it. | `pattern` | `security:write` |
| [`code_alerts`](/reference/api/code-scanning/list-code-scanning-alerts/) | Code scanning alerts, open and worst first: `repo`, or `workspace`. Filter with `state`, `severity`, `tool`, `rule_id`. | None | `security:read` |
| [`code_alert`](/reference/api/code-scanning/get-code-scanning-alert/) | One alert by `number`, with its activity and analyses. | `repo`, `number` | `security:read` |
| [`update_code_alert`](/reference/api/code-scanning/update-code-scanning-alert/) | Dismiss (`state` `dismissed`, `dismissed_reason` `false_positive`, `wont_fix` or `used_in_tests`) or reopen. | `repo`, `number`, `state` | `security:write` |
| [`analyses`](/reference/api/code-scanning/list-code-scanning-analyses/) | Analyses, newest first. | `repo` | `security:read` |
| [`upload_sarif`](/reference/api/code-scanning/upload-sarif/) | Upload a SARIF 2.1.0 file, gzipped and base64-encoded, for a `commit_sha` and `ref`. | `repo`, `commit_sha`, `ref`, `sarif` | `security:write` |
| [`sarif_upload`](/reference/api/code-scanning/get-sarif-upload/) | Whether an upload was read, its analyses and errors. | `repo`, `id` | `security:read` |
| [`fix`](/reference/api/code-scanning/fix-security-alert/) | Put g1t on an issue to fix a code scanning, vulnerability or secret alert. Also needs `issues:write` and `agents:run`. | `repo`, `id` | `security:write` |
| [`vulnerability_alerts`](/reference/api/supply-chain/list-vulnerability-alerts/) | Vulnerability alerts: `repo`, or `workspace`. Filter with `state`, `severity`, `ecosystem`, `package`. | None | `security:read` |
| [`vulnerability_alert`](/reference/api/supply-chain/get-vulnerability-alert/) | One alert by `id`. | `repo`, `id` | `security:read` |
| [`update_vulnerability_alert`](/reference/api/supply-chain/update-vulnerability-alert/) | Dismiss (`state` `dismissed`, `reason` `fix_started`, `no_bandwidth`, `tolerable_risk`, `inaccurate` or `not_used`) or reopen. | `repo`, `id`, `state` | `security:write` |
| [`dependency_graph`](/reference/api/supply-chain/get-dependency-graph/) | Every package the lockfiles resolve, direct or transitive, with licenses. | `repo` | `security:read` |
| [`sbom`](/reference/api/supply-chain/get-sbom/) | The dependency graph as an SPDX 2.3 document, in `sbom`. | `repo` | `security:read` |
| [`compare_dependencies`](/reference/api/supply-chain/compare-dependencies/) | What changes between `basehead` (`base...head`), and whether it passes dependency review. | `repo`, `basehead` | `security:read` |
| [`settings`](/reference/api/security-settings/get-security-settings/) | A repository's security settings, and whether the paid features are on. | `repo` | `security:read` |
| [`update_settings`](/reference/api/security-settings/update-security-settings/) | Change `code_scanning_gate`, `dependency_review`, `review_fail_on`, `review_deny_licenses`, `review_comment`. Maintain role. | `repo` | `security:write` |
| [`workspace_settings`](/reference/api/security-settings/get-workspace-security-settings/) | A workspace's delegated bypass and validity checks. | `workspace` | `security:read` |
| [`update_workspace_settings`](/reference/api/security-settings/update-workspace-security-settings/) | Turn `delegated_bypass` or `validity_checks` on or off. Owners only. | `workspace` | `security:write` |
| [`overview`](/reference/api/security-settings/get-security-overview/) | A workspace's alerts by type and severity, trends and coverage. | `workspace` | `security:read` |

## `webhook`

HTTPS addresses that are sent signed events as they happen. Give `repo` for
a repository's webhooks, or `workspace` for a workspace's own. See
[webhooks](/guides/webhooks/).

| Action | What it does | Required | Scope |
| --- | --- | --- | --- |
| [`list`](/reference/api/webhooks/list-webhooks/) | The webhooks, with how each one's latest delivery went. A repository's need the Admin role; a workspace's, a member. | None | `webhooks:read` |
| [`create`](/reference/api/webhooks/create-webhook/) | Send events to an HTTPS address: `events` to choose them, `secret` to sign with. A ping is sent at once. | `url` | `webhooks:admin` |
| [`update`](/reference/api/webhooks/update-webhook/) | Change its `url`, `events`, or whether it is `active`. | `id` | `webhooks:admin` |
| [`delete`](/reference/api/webhooks/delete-webhook/) | Remove it and its delivery log. | `id` | `webhooks:admin` |
| [`ping`](/reference/api/webhooks/ping-webhook/) | Send it a ping. | `id` | `webhooks:admin` |
| [`list_deliveries`](/reference/api/webhooks/list-webhook-deliveries/) | Its latest deliveries, with request, response and retries. | `id` | `webhooks:read` |
| [`redeliver`](/reference/api/webhooks/redeliver-webhook/) | Send a delivery again. | `delivery` | `webhooks:admin` |

## `access`

Who can do what in a repository: its people and their
[roles](/guides/access-and-roles/) (read, triage, write, maintain and
admin), invitations, outside collaborators, and a workspace's base
permission. An agent's token cannot use any of these.

| Action | What it does | Required | Scope |
| --- | --- | --- | --- |
| [`list_collaborators`](/reference/api/access/list-collaborators/) | Everyone with a role on it, with the role, where it comes from (`owner`, `base` or `direct`) and whether they are members; the base permission; and, with the Admin role, pending invitations. Needs the Write role. | `repo` | `access:read` |
| [`get_permission`](/reference/api/access/get-collaborator-permission/) | Someone's role, where it comes from, and what it lets them do. Needs the Write role, or to be about yourself. | `repo`, `username` | `access:read` |
| [`add_collaborator`](/reference/api/access/add-collaborator/) | Give someone a role by username or email address. A member gets it at once; anyone else is invited, and becomes an outside collaborator on accepting. Needs the Admin role. On a free workspace, only members: inviting anyone else is refused with `402` until it starts the plan. | `repo`, `invitee`, `role` | `access:admin` |
| [`update_collaborator`](/reference/api/access/update-collaborator/) | Change someone's direct role, or their pending invitation's. Needs the Admin role. | `repo`, `username`, `role` | `access:admin` |
| [`remove_collaborator`](/reference/api/access/remove-collaborator/) | Take away someone's direct role. Needs the Admin role, or to be your own. | `repo`, `username` | `access:admin` |
| [`list_invitations`](/reference/api/access/list-repo-invitations/) | Its pending invitations. Needs the Admin role. | `repo` | `access:read` |
| [`revoke_invitation`](/reference/api/access/revoke-repo-invitation/) | Withdraw a pending invitation. Needs the Admin role. | `repo`, `id` | `access:admin` |
| [`set_base_permission`](/reference/api/access/set-base-permission/) | What every member gets on each repository: `none`, `read`, `write` (the default) or `admin`. Owners only. | `workspace`, `base_permission` | `access:admin` |
| [`list_outside_collaborators`](/reference/api/access/list-outside-collaborators/) | People with roles on its repositories who are not members, and what they can reach. Owners only. | `workspace` | `access:read` |

## `team`

[Teams](/guides/teams/): groups of a workspace's members, given roles on
repositories together, mentioned as `@workspace/team` and asked to review
together. Name a team by `workspace` and its slug, `team`. Any member may
create one; the workspace's owners and the team's maintainers manage it. A
`secret` team is seen only by its own people and the owners. Changes are
for people: an agent's or a workspace's token cannot make them.

| Action | What it does | Required | Scope |
| --- | --- | --- | --- |
| [`list`](/reference/api/teams/list-teams/) | The workspace's teams you can see, yours first; `query` narrows by name or slug. Members only. | `workspace` | `workspace:read` |
| [`get`](/reference/api/teams/get-team/) | One team: its `visibility`, `parent`, `notify`, `review_assignment`, counts, your `viewer_role` and whether you may change it (`can_manage`). | `workspace`, `team` | `workspace:read` |
| [`create`](/reference/api/teams/create-team/) | Create a team; you become its maintainer. Members may, unless the workspace's `team_creation` is `owners`. `slug` is made from `name` unless given; `visibility`, `parent`, `notify`, and `members` to add by username. | `workspace`, `name` | `workspace:admin` |
| [`update`](/reference/api/teams/update-team/) | Change its `name`, `slug`, `description`, `visibility`, `parent` (`""` for none), `notify` or `review_assignment`. Owners and its maintainers. | `workspace`, `team` | `workspace:admin` |
| [`delete`](/reference/api/teams/delete-team/) | Delete it; its child teams move up to its parent, and the roles it gave go. Owners and its maintainers. | `workspace`, `team` | `workspace:admin` |
| [`list_members`](/reference/api/teams/list-team-members/) | Its people and their `role` (`member` or `maintainer`); with `include_child_teams`, its child teams' people too, each with `via`. | `workspace`, `team` | `workspace:read` |
| [`set_member`](/reference/api/teams/set-team-member/) | Add a member of the workspace, or change their `role`. Owners and its maintainers. | `workspace`, `team`, `username` | `workspace:admin` |
| [`remove_member`](/reference/api/teams/remove-team-member/) | Take someone out. Owners and its maintainers; anyone may leave. | `workspace`, `team`, `username` | `workspace:admin` |
| [`list_child_teams`](/reference/api/teams/list-child-teams/) | The teams nested directly under it. | `workspace`, `team` | `workspace:read` |
| [`list_repos`](/reference/api/teams/list-team-repos/) | The repositories it has a role on, with `inherited_from` for one a parent gives it. | `workspace`, `team` | `workspace:read` |
| [`set_repo`](/reference/api/teams/set-team-repo/) | Give it a `role` (read, triage, write, maintain or admin) on a repository of its workspace, named by `repo` (its name, or `owner/name`). Admin role on the repository. | `workspace`, `team`, `repo`, `role` | `access:admin` |
| [`remove_repo`](/reference/api/teams/remove-team-repo/) | Take its role on a repository away. Admin role on the repository, an owner, or one of its maintainers. | `workspace`, `team`, `repo` | `access:admin` |
| [`set_review_assignment`](/reference/api/teams/set-team-review-assignment/) | Whom it picks when asked to review: `enabled`, `algorithm` (`round_robin` or `load_balance`), `count` (1 to 10), `skip_busy` and `busy_at`, `include_child_teams`, `excluded` and `notify_team`. Fields left out keep their value. Owners and its maintainers. | `workspace`, `team` | `workspace:admin` |
| [`list_user_teams`](/reference/api/teams/list-user-teams/) | The teams someone is in. Members only. | `workspace`, `username` | `workspace:read` |

## `workspace`

Workspaces own repositories: create, update or delete one, invite members,
connect [integrations](/guides/integrations/) and model providers, read and
change its [projects](/guides/projects/) (what each is, where it runs, its
links), and keep your own
[pinned projects](/guides/workspaces/#pinned-and-recent-projects) at the top
of its sidebar. See [workspaces](/guides/workspaces/).

| Action | What it does | Required | Scope |
| --- | --- | --- | --- |
| [`get`](/reference/api/workspaces/get-workspace/) | One workspace you belong to: its name, description and member count, its `base_permission` and `team_creation`. Members only. | `workspace` | `workspace:read` |
| [`create`](/reference/api/workspaces/create-workspace/) | Create a workspace. A new one is free, and each person owns at most one free workspace: refused with `402` while you own one, until it is on the plan or deleted. See [one free workspace per person](/guides/usage-and-billing/#one-free-workspace-per-person). | `slug` | `workspace:admin` |
| [`update`](/reference/api/workspaces/update-workspace/) | Change its display name and description, who may create its teams (`team_creation`: `members` or `owners`), and with the `access:admin` scope too, its `base_permission`. Only the fields given change; the slug never does. Owners only. | `workspace` | `workspace:admin` |
| [`delete`](/reference/api/workspaces/delete-workspace/) | Delete an empty workspace whose billing is settled; `confirm` is its slug. Owners only. See [deleting a workspace](/guides/workspaces/#delete-a-workspace). | `workspace`, `confirm` | `workspace:admin` |
| [`list_invites`](/reference/api/invites/list-workspace-invites/) | A workspace's invites. Owners only. | `workspace` | `workspace:read` |
| [`invite_member`](/reference/api/invites/invite-member/) | Invite an address into a workspace, with an invite bound to it. Owners only. A free workspace cannot invite: refused with `402` until it starts the plan. | `workspace`, `email` | `workspace:admin` |
| [`revoke_invite`](/reference/api/invites/revoke-workspace-invite/) | Revoke a workspace's pending invite. Owners only. | `workspace`, `id` | `workspace:admin` |
| [`list_integrations`](/reference/api/integrations/list-integrations/) | The workspace's connections. Secrets are never returned. Members only. | `workspace` | `workspace:read` |
| [`connect_integration`](/reference/api/integrations/connect-integration/) | Connect a model provider (Anthropic, OpenAI, Gemini, or a compatible endpoint), Sentry, Datadog, a webhook, Jira or Linear, with `config` and `secret`. Owners only. | `workspace`, `provider` | `workspace:admin` |
| [`disconnect_integration`](/reference/api/integrations/disconnect-integration/) | Remove it and its secrets. Owners only. | `workspace`, `id` | `workspace:admin` |
| [`test_integration`](/reference/api/integrations/test-integration/) | Check its credentials against the system it connects to. Owners only. | `workspace`, `id` | `workspace:admin` |
| [`get_model_routes`](/reference/api/integrations/get-model-routes/) | Which provider and model each kind of work goes to. Members only. | `workspace` | `workspace:read` |
| [`set_model_routes`](/reference/api/integrations/set-model-routes/) | Replace them: each route has `task`, `connection_id` (null for g1t's models) and `model` (on g1t's models: `small`, `large`, `frontier`, or null for Auto). Owners only. | `workspace`, `routes` | `workspace:admin` |
| [`list_projects`](/reference/api/projects/list-projects/) | Its projects you can see, by name: each with its `kind` and `kind_reason`, where it `runs` and its `production_url`, its repository and `root_dir`, and its `links`. | `workspace` | `repo:read` |
| [`get_project`](/reference/api/projects/get-project/) | One project, with what a person set (`setting`) and what detection decides (`detected`). | `workspace`, `project` | `repo:read` |
| [`update_project`](/reference/api/projects/update-project/) | Change its `name`, `description`, `root_dir`, `kind`, `runs`, `production_url`, `homepage`, `docs_url` or `links`; only what you give changes. `auto` leaves `kind` or `runs` to detection, null clears a link or goes back to the repository's, and `links` replaces its other links (at most 10). Maintain role or higher. | `workspace`, `project` | `repo:write` |
| [`list_pinned_projects`](/reference/api/pinned-projects/list-pinned-projects/) | Your pinned projects in it, in your order, each with its `position`. Your own: a personal token or an OAuth sign-in. | `workspace` | `account:read` |
| [`pin_project`](/reference/api/pinned-projects/pin-project/) | Pin a project you can see, at `position` (0 first) or at the end; at most 8 a workspace. Returns your pins. | `workspace`, `project` | `account:write` |
| [`unpin_project`](/reference/api/pinned-projects/unpin-project/) | Unpin it. Returns your pins. | `workspace`, `project` | `account:write` |
| [`reorder_pinned_projects`](/reference/api/pinned-projects/reorder-pinned-projects/) | Put your pins in a new order: `projects` names each pinned project's slug once. | `workspace`, `projects` | `account:write` |
| [`list_rulesets`](/reference/api/rules/list-workspace-rulesets/) | The workspace's own [rulesets](/guides/rules/). Members only. | `workspace` | `workspace:read` |
| [`get_ruleset`](/reference/api/rules/get-workspace-ruleset/) | One of them by `id`. Members only. | `workspace`, `id` | `workspace:read` |
| [`create_ruleset`](/reference/api/rules/create-workspace-ruleset/) | Create one, with `conditions.repository` choosing its repositories. Owners only. | `workspace` | `workspace:admin` |
| [`update_ruleset`](/reference/api/rules/update-workspace-ruleset/) | Change one. Owners only. | `workspace`, `id` | `workspace:admin` |
| [`delete_ruleset`](/reference/api/rules/delete-workspace-ruleset/) | Delete one. Owners only. | `workspace`, `id` | `workspace:admin` |
| [`rule_evaluations`](/reference/api/rules/list-workspace-rule-evaluations/) | How rules judged changes across its repositories, with insights. Members only. | `workspace` | `workspace:read` |

## `billing`

A workspace's billing: its usage, its budget, its AI credit, its
invoices and its [AI Gateway](/guides/ai-gateway/) requests. `usage` is the default action. Amounts are whole millionths of a
dollar (`_micros`), or cents where a field says `_cents`. Members of the
workspace read it, a workspace's own token included. Changing the budget
and buying AI credit are for its owners, as people: signed in or with a
personal access token. A workspace's token and g1t's agents never change
billing, whatever their scopes, and no preset but full access includes
`billing:write`. See [usage and billing](/guides/usage-and-billing/).

| Action | What it does | Required | Scope |
| --- | --- | --- | --- |
| [`usage`](/reference/api/billing/get-usage/) | Usage over `from` to `until` (UTC days, `until` included; the month so far when left out), narrowed by `products` and `projects`: `totals` and what paid for it, each day, and each product's meters with their daily amounts and split by project. `group_by` (`product`, `project` or `day`) adds `groups`. | `workspace` | `billing:read` |
| [`budget`](/reference/api/billing/get-budget/) | The monthly spend limit (`amount_micros`, or `automatic`), `spent_micros` this month, `max_amount_micros`, `alerts`, `pause_at_limit`, `webhook` and `state`. | `workspace` | `billing:read` |
| [`set_budget`](/reference/api/billing/set-budget/) | Change the limit (`amount_micros`, null for the automatic one), `alerts` (some of 50, 75, 90 and 100), `pause_at_limit` or `webhook`. Fields left out keep their value. Owners, as people. | `workspace` | `billing:write` |
| [`ai_credit`](/reference/api/billing/get-ai-credit/) | AI credit left, its grants, whether runs are `blocked` for want of it, auto-reload, and what can be bought. | `workspace` | `billing:read` |
| [`buy_ai_credit`](/reference/api/billing/buy-ai-credit/) | A payment page (`url`) to buy `amount_cents` of credit, in whole dollars from $10 to $1,000, for a person to open and pay; it returns to the workspace's billing page. Owners, as people. | `workspace`, `amount_cents` | `billing:write` |
| [`invoices`](/reference/api/billing/list-invoices/) | Every invoice (`invoices`, in cents), g1t's itemised usage invoices (`usage_invoices`), and what the next one comes to so far (`upcoming`). | `workspace` | `billing:read` |
| [`billing_details`](/reference/api/billing/get-billing-details/) | Who invoices are made out to, and the payment method on file as far as it is safe to show. | `workspace` | `billing:read` |
| [`gateway_requests`](/reference/api/billing/list-gateway-requests/) | The workspace's recent [AI Gateway](/guides/ai-gateway/) requests, newest first: model, tokens by kind, `cost_micros`, `charged_micros`, `status`, `own_key` and the token that sent each. `limit` (50, at most 200) and `before` (the last page's `next`) page through them. Kept 30 days. | `workspace` | `models:read` |

## `notifications`

Your [inbox](/guides/inbox/): one thread per issue, pull request, workflow
on a branch or deployment, with why you were told (`reason`), and what you
subscribe to and watch. `list` is the default action. It is your own: a
personal access token or an OAuth sign-in can use it, a workspace's token
cannot. Name an issue or pull request by a thread's `id`, or by `repo` and
`number`.

| Action | What it does | Required | Scope |
| --- | --- | --- | --- |
| [`list`](/reference/api/notifications/list-notifications/) | Your unread threads, latest first. With `all`, read ones too; `view` `saved` or `done` lists those instead. Filter by `reason`, `severity`, `participating`, `since`, `before` or `repo`. | None | `notifications:read` |
| [`get`](/reference/api/notifications/get-notification-thread/) | One thread, its last 10 activities, and your subscription to it. | `id` | `notifications:read` |
| [`mark_read`](/reference/api/notifications/mark-thread-read/) | Mark a thread read, or with `read` false, unread. | `id` | `notifications:write` |
| [`mark_all_read`](/reference/api/notifications/mark-notifications-read/) | Mark every thread read, or one repository's with `repo`. Threads with activity after `last_read_at` (now, when left out) stay unread. | None | `notifications:write` |
| [`done`](/reference/api/notifications/mark-thread-done/) | Move a thread to Done; new activity brings it back. With `done` false, move it back now. | `id` | `notifications:write` |
| [`save`](/reference/api/notifications/save-thread/) | Save a thread so it is kept, or with `saved` false, unsave it. | `id` | `notifications:write` |
| [`snooze`](/reference/api/notifications/snooze-thread/) | Hide a thread until `until` (RFC 3339). Leave `until` out to bring it back now. | `id` | `notifications:write` |
| [`subscription`](/reference/api/notifications/get-thread-subscription/) | Whether you are subscribed to an issue or pull request, or ignore it, and why. | `id`, or `repo` and `number` | `notifications:read` |
| [`subscribe`](/reference/api/notifications/set-thread-subscription/) | Subscribe (`subscribed`, true unless you say), unsubscribe (`subscribed` false), or ignore it (`ignored` true). | `id`, or `repo` and `number` | `notifications:write` |
| [`unsubscribe`](/reference/api/notifications/delete-thread-subscription/) | Unsubscribe until you comment or are mentioned. What is asked of you directly still reaches you. | `id`, or `repo` and `number` | `notifications:write` |
| [`watching`](/reference/api/notifications/get-repo-subscription/) | How you watch a repository: `participating`, `all`, `ignore` or `custom`, with `events`. | `repo` | `notifications:read` |
| [`watch`](/reference/api/notifications/set-repo-subscription/) | Watch a repository at a `level`, with `events` (`issues`, `pulls`, `deployments`, `security`) for `custom`. | `repo` | `notifications:write` |
| [`unwatch`](/reference/api/notifications/delete-repo-subscription/) | Go back to the default: only what you take part in or are mentioned in. | `repo` | `notifications:write` |
| [`watched`](/reference/api/notifications/list-watched-repos/) | The repositories you watch other than the default way. | None | `notifications:read` |

## `account`

Who the token acts as and its workspaces, your email addresses, your
invites while g1t is [invite-only](/guides/authentication/#invites), and
invitations to repositories waiting for you. `whoami` is the default
action, and needs no scope. An agent's token and a workspace's token cannot
use the email and invite actions.

| Action | What it does | Required | Scope |
| --- | --- | --- | --- |
| [`whoami`](/reference/api/accounts/whoami/) | Who the access token acts as, and the workspaces it can work in. `kind` is `user`, `workspace` or `agent`. | None | None |
| [`list_emails`](/reference/api/accounts/list-emails/) | Your email addresses and email settings. People only. | None | `account:read` |
| [`add_email`](/reference/api/accounts/add-email/) | Add an address; g1t emails it a link to confirm it. | `email`, `password` | `account:write` |
| [`remove_email`](/reference/api/accounts/remove-email/) | Remove an address; never the primary or the last confirmed one. | `email`, `password` | `account:write` |
| [`update_email_settings`](/reference/api/accounts/update-email-settings/) | Change `primary` or `backup` (with `password`), `private_email` or `block_private_pushes`. See [email addresses](/guides/authentication/#email-addresses). | None | `account:write` |
| [`list_invites`](/reference/api/invites/list-invites/) | Your invites, newest first, and how many you have left. | None | `account:read` |
| [`create_invite`](/reference/api/invites/create-invite/) | Make an invite; with `email`, only that address can use it and it is emailed there. With `workspace`, use that workspace's granted invites. | None | `account:write` |
| [`revoke_invite`](/reference/api/invites/revoke-invite/) | Revoke a pending invite; it comes back to whoever it was charged to. | `id` | `account:write` |
| [`list_repository_invitations`](/reference/api/access/list-my-repo-invitations/) | The invitations to repositories waiting for your answer. | None | `account:read` |
| [`accept_repository_invitation`](/reference/api/access/accept-repo-invitation/) | Accept one; its role is yours at once. | `id` | `account:write` |
| [`decline_repository_invitation`](/reference/api/access/decline-repo-invitation/) | Decline one. | `id` | `account:write` |


## What g1t can use

g1t works with a [run credential](/guides/working-with-g1t/#credentials):
a token bound to its run and its own repository, acting as `g1t` on
behalf of the person who started the work, and only while that person is
still a member of the workspace or has a role on one of its repositories. It
has that person's role on its repository, but never more than Write. Which
actions it may use depends on the kind of run.

| Run | Actions |
| --- | --- |
| Implement, revise, answer | Reading: `repository` `get`, `list_labels`, `list_milestones`, `get_milestone` and `list_events`; `issue` `list`, `get` and `labels`; `pull_request` `list`, `get`, `changes`, `read_session` and `merge_queue`; `memory` `recall`; `search` `code`, `context` and `entity`; `workflow` `list`, `list_runs`, `get_run` and `job_logs`. Then `issue` `create` and `comment`, `memory` `remember`, `agent` `message`, `answer` and `take_messages`, and `search` `ticket`. |
| Review | The same reading actions, and `issue` `comment`, `pull_request` `review` and `search` `ticket`. |
| Plan | The same reading actions, and `issue` `create` and `search` `ticket`. |
| Catch up | The reading actions only. |

No agent's token can use the `workspace`, `access`, `team`, `secret`, `webhook` or
`notifications` tools (g1t acts as `g1t`, which has no inbox), the controls of `workflow`, or `pull_request` `merge`, `agent`
`assign` and `delegate`, `plan` `create` and `apply`, `issue` `import`, or
any `repository` action that creates, changes, renames, archives,
transfers, deletes, restores or purges a repository, or dismisses or
reopens a security alert, or the `security` actions that decide about
security: `update_secret_alert`, `bypass`, `review_bypass`, the pattern
changes, `update_code_alert`, `update_vulnerability_alert`, `fix`,
`update_settings` and `update_workspace_settings`. Every repository it
names must be its own. `tools/list` shows such a token only the tools and
actions it may use; a call to any other is refused with the rule that
refused it, and recorded in the workspace's [audit log](/guides/audit-log/),
as is every call it makes.
