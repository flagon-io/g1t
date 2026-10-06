---
title: MCP tools
description: Every tool the g1t MCP server exposes, with its required inputs and the matching REST route.
---

The MCP server at `https://mcp.g1t.sh` exposes the tools below. Each is the
same operation as a route of the [REST API](/reference/api/), so the two
always agree. To connect a client, see
[connect an agent](/guides/bring-your-own-agent/).

## Conventions

- `repo` is always `owner/name`, such as `"flagon-io/hello"`.
- `number` names an issue or a pull request. The two share one sequence per
  repository, so a number names exactly one of them.
- Inputs are `snake_case`. Results are JSON, with `snake_case` fields, as
  the REST API returns them.
- A tool that fails returns its error as the result, with `isError` set, so
  the agent can read it and act on it.
- Reading a public repository needs no sign-in through the API. Through MCP,
  every call needs to be signed in.

Required inputs are listed in each table. Optional inputs are described in
the tool's schema, which `tools/list` returns, and in the
[API reference](/reference/api/).

## Account and workspaces

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `whoami` | | Who the access token acts as, and the workspaces it can work in. `kind` is `user`, `workspace` or `agent`. | [`GET /user`](/reference/api/accounts/whoami/) |
| `create_workspace` | `slug` | Create a workspace. | [`POST /workspaces`](/reference/api/workspaces/create-workspace/) |
| `list_emails` | | Your email addresses and email settings. People only. | [`GET /user/emails`](/reference/api/accounts/list-emails/) |
| `add_email` | `email`, `password` | Add an address; g1t emails it a link to confirm it. | [`POST /user/emails`](/reference/api/accounts/add-email/) |
| `remove_email` | `email`, `password` | Remove an address; never the primary or the last confirmed one. | [`DELETE /user/emails/{email}`](/reference/api/accounts/remove-email/) |
| `update_email_settings` | | Change `primary` or `backup` (with `password`), `private_email` or `block_private_pushes`. See [email addresses](/guides/authentication/#email-addresses). | [`PATCH /user/email-settings`](/reference/api/accounts/update-email-settings/) |
| `delete_workspace` | `workspace`, `confirm` | Delete an empty workspace whose billing is settled; `confirm` is its slug. Owners only. See [deleting a workspace](/guides/workspaces/#delete-a-workspace). | [`DELETE /workspaces/{workspace}`](/reference/api/workspaces/delete-workspace/) |

## Invites

While g1t is invite-only, every new account needs an invite. See
[invites](/guides/authentication/#invites). An agent's token and a
workspace's token cannot make invites.

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `list_invites` | | Your invites, newest first, and how many you have left. | [`GET /user/invites`](/reference/api/invites/list-invites/) |
| `create_invite` | | Make an invite; with `email`, only that address can use it and it is emailed there. With `workspace`, use that workspace's granted invites. | [`POST /user/invites`](/reference/api/invites/create-invite/) |
| `revoke_invite` | `id` | Revoke a pending invite; it comes back to whoever it was charged to. | [`DELETE /user/invites/{id}`](/reference/api/invites/revoke-invite/) |
| `list_workspace_invites` | `workspace` | A workspace's invites. Owners only. | [`GET /workspaces/{workspace}/invitations`](/reference/api/invites/list-workspace-invites/) |
| `invite_member` | `workspace`, `email` | Invite an address into a workspace, with an invite bound to it. Owners only. | [`POST /workspaces/{workspace}/invitations`](/reference/api/invites/invite-member/) |
| `revoke_workspace_invite` | `workspace`, `id` | Revoke a workspace's pending invite. Owners only. | [`DELETE /workspaces/{workspace}/invitations/{id}`](/reference/api/invites/revoke-workspace-invite/) |

## Repositories

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `list_repos` | | Repositories you can see, optionally filtered by `query`. | [`GET /repos?q=`](/reference/api/repositories/list-repos/) |
| `get_repo` | `repo` | One repository's details. | [`GET /repos/{owner}/{name}`](/reference/api/repositories/get-repo/) |
| `create_repo` | `name` | Create a repository in one of your workspaces, empty or as a copy of a public git repository (`import_url`). `workspace` may be left out if you belong to exactly one. | [`POST /repos`](/reference/api/repositories/create-repo/) |
| `update_repo` | `repo` | Change its `description`, `website`, `topics` and `default_branch`, whether its default branch is `protected`, and whether it is `private`. Maintain role; `private` and `default_branch` need Admin. | [`PATCH /repos/{owner}/{name}`](/reference/api/repositories/update-repo/) |
| `rename_repo` | `repo`, `name` | Give it a new name in its workspace; the old address redirects. Admin role. | [`POST /repos/{owner}/{name}/rename`](/reference/api/repositories/rename-repo/) |
| `rename_branch` | `repo`, `branch`, `new_name` | Rename a branch; its pull requests follow, and web addresses that name the old branch redirect. Write role; the default branch needs Admin. | [`POST /repos/{owner}/{name}/branches/{branch}/rename`](/reference/api/repositories/rename-branch/) |
| `set_repo_visibility` | `repo`, `private`, `confirm` | Make it public or private; `confirm` is its full name. Admin role. | [`POST /repos/{owner}/{name}/visibility`](/reference/api/repositories/set-repo-visibility/) |
| `archive_repo` | `repo` | Make it read-only: pushes and merges are refused, issues and pull requests are locked, agents and workflows stop. Admin role. | [`POST /repos/{owner}/{name}/archive`](/reference/api/repositories/archive-repo/) |
| `unarchive_repo` | `repo` | Make it writable again. Admin role. | [`POST /repos/{owner}/{name}/unarchive`](/reference/api/repositories/unarchive-repo/) |
| `transfer_repo` | `repo`, `to` | Move it to another workspace, keeping its name; the old address redirects. Owners of both workspaces only. See [transferring a repository](/guides/transferring-repositories/). | [`POST /repos/{owner}/{name}/transfer`](/reference/api/repositories/transfer-repo/) |
| `delete_repo` | `repo`, `confirm` | Delete it; `confirm` is its full name. It can be restored for 30 days, then it is purged. Owners only. | [`DELETE /repos/{owner}/{name}`](/reference/api/repositories/delete-repo/) |
| `list_deleted_repos` | `workspace` | The workspace's recently deleted repositories, with when each is purged. Owners only; empty for anyone else. | [`GET /workspaces/{workspace}/repos/deleted`](/reference/api/repositories/list-deleted-repos/) |
| `restore_repo` | `repo` | Bring a deleted repository back at the path it had. Owners only. | [`POST /repos/{owner}/{name}/restore`](/reference/api/repositories/restore-repo/) |
| `purge_repo` | `repo`, `confirm` | Remove a deleted repository for good now, and free its name; `confirm` is its full name. Owners only. | [`POST /repos/{owner}/{name}/purge`](/reference/api/repositories/purge-repo/) |
| `get_repo_settings` | `repo` | How it handles pull requests: approvals, checks, being up to date, and how g1t's agents are reviewed, revised and merged. | [`GET /repos/{owner}/{name}/settings`](/reference/api/repositories/get-repo-settings/) |
| `update_repo_settings` | `repo` | Change those settings. Only the fields given change. Maintain role. | [`PATCH /repos/{owner}/{name}/settings`](/reference/api/repositories/update-repo-settings/) |
| `list_labels` | `repo` | The labels available on its issues. | [`GET /repos/{owner}/{name}/labels`](/reference/api/issues/list-labels/) |
| `list_events` | `repo` | Its timeline, newest first. `before` pages back. | [`GET /repos/{owner}/{name}/events`](/reference/api/repositories/list-events/) |

See [managing a repository](/guides/managing-repositories/) for what each
of these changes, and what refuses it, and
[access and roles](/guides/access-and-roles/) for the role each needs.

`update_repo_settings` takes `required_approvals`, `count_agent_approvals`,
`allow_ignoring_checks`, `require_up_to_date`, `agent_review`,
`max_revisions`, `auto_merge` and `merge_queue`. See
[what a repository can ask for](/guides/g1t-agents/#what-a-repository-can-ask-for).

## Access

Who can do what in a repository: its people and their
[roles](/guides/access-and-roles/) (read, triage, write, maintain and
admin), invitations, and a workspace's base permission. Changing who has
access takes a person's own token; an agent's token cannot use any of these.

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `list_collaborators` | `repo` | Everyone with a role on it, with the role, where it comes from (`owner`, `base` or `direct`) and whether they are members; the base permission; and, with the Admin role, pending invitations. Needs the Write role. | [`GET /repos/{owner}/{name}/collaborators`](/reference/api/access/list-collaborators/) |
| `add_collaborator` | `repo`, `invitee`, `role` | Give someone a role by username or email address. A member gets it at once; anyone else is invited, and becomes an outside collaborator on accepting. Needs the Admin role. | [`POST /repos/{owner}/{name}/collaborators`](/reference/api/access/add-collaborator/) |
| `update_collaborator` | `repo`, `username`, `role` | Change someone's direct role, or their pending invitation's. Needs the Admin role. | [`PATCH /repos/{owner}/{name}/collaborators/{username}`](/reference/api/access/update-collaborator/) |
| `remove_collaborator` | `repo`, `username` | Take away someone's direct role. Needs the Admin role, or to be your own. | [`DELETE /repos/{owner}/{name}/collaborators/{username}`](/reference/api/access/remove-collaborator/) |
| `get_collaborator_permission` | `repo`, `username` | Someone's role, where it comes from, and what it lets them do. Needs the Write role, or to be about yourself. | [`GET /repos/{owner}/{name}/collaborators/{username}/permission`](/reference/api/access/get-collaborator-permission/) |
| `list_repo_invitations` | `repo` | Its pending invitations. Needs the Admin role. | [`GET /repos/{owner}/{name}/invitations`](/reference/api/access/list-repo-invitations/) |
| `revoke_repo_invitation` | `repo`, `id` | Withdraw a pending invitation. Needs the Admin role. | [`DELETE /repos/{owner}/{name}/invitations/{id}`](/reference/api/access/revoke-repo-invitation/) |
| `list_my_repo_invitations` | | The invitations to repositories waiting for your answer. | [`GET /user/repository_invitations`](/reference/api/access/list-my-repo-invitations/) |
| `accept_repo_invitation` | `id` | Accept one; its role is yours at once. | [`PATCH /user/repository_invitations/{id}`](/reference/api/access/accept-repo-invitation/) |
| `decline_repo_invitation` | `id` | Decline one. | [`DELETE /user/repository_invitations/{id}`](/reference/api/access/decline-repo-invitation/) |
| `set_base_permission` | `workspace`, `base_permission` | What every member gets on each repository: `none`, `read`, `write` (the default) or `admin`. Owners only. | [`PATCH /workspaces/{workspace}`](/reference/api/access/set-base-permission/) |
| `list_outside_collaborators` | `workspace` | People with roles on its repositories who are not members, and what they can reach. Owners only. | [`GET /workspaces/{workspace}/outside_collaborators`](/reference/api/access/list-outside-collaborators/) |

## Search

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `search` | `query` | Search all of g1t: repositories, code on default branches, issues, pull requests, people and workspaces. Public results for everyone; private ones in workspaces you belong to. `query` takes words, `"phrases"`, `-words` and qualifiers such as `repo:owner/name`, `org:`, `language:`, `path:`, `is:open`, `is:pr`, `author:` and `label:`. `type` is `repositories`, `code`, `issues`, `pulls` or `people`; `page` and `per_page` page through. Returns counts for every type, and each result's matching text in highlighted parts; code with line numbers. | [`GET /search`](/reference/api/search/search/) |

See [search and Explore](/guides/search/) for the full syntax. `search`
looks across all of g1t; `search_context`, under [Memory](#memory), asks one
workspace's context hub.

## Issues

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `list_issues` | `repo` | Issues, newest first, by `state` and `label`. | [`GET /repos/{owner}/{name}/issues`](/reference/api/issues/list-issues/) |
| `get_issue` | `repo`, `number` | An issue: description, labels, acceptance checks, comments, and every pull request made for it. | [`GET /repos/{owner}/{name}/issues/{number}`](/reference/api/issues/get-issue/) |
| `create_issue` | `repo`, `title` | Open an issue, with `body`, `labels` and `checks`. | [`POST /repos/{owner}/{name}/issues`](/reference/api/issues/create-issue/) |
| `update_issue` | `repo`, `number` | Change its title, body, labels or assignees. Labels and assignees each replace the whole set. | [`PATCH /repos/{owner}/{name}/issues/{number}`](/reference/api/issues/update-issue/) |
| `close_issue` | `repo`, `number` | Close it as `completed` or `not_planned`. | [`POST /repos/{owner}/{name}/issues/{number}/close`](/reference/api/issues/close-issue/) |
| `reopen_issue` | `repo`, `number` | Reopen a closed issue. | [`POST /repos/{owner}/{name}/issues/{number}/reopen`](/reference/api/issues/reopen-issue/) |
| `assign_issue` | `repo`, `number` | Assign it to the [g1t agent](/guides/g1t-agents/), which opens a pull request and sees it through. Preview. | [`POST /repos/{owner}/{name}/issues/{number}/assign`](/reference/api/issues/assign-issue/) |
| `add_comment` | `repo`, `number`, `body` | Comment on an issue or a pull request; with `path` and `line`, on one line of a pull request's change. | [`POST /repos/{owner}/{name}/issues/{number}/comments`](/reference/api/issues/add-comment/) |

## Pull requests

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `list_pull_requests` | `repo` | Pull requests, newest first. `open` covers drafts and those ready for review. | [`GET /repos/{owner}/{name}/pulls`](/reference/api/pull-requests/list-pull-requests/) |
| `get_pull_request` | `repo`, `number` | Status, head commit, comments and reviews, its issue, the latest acceptance check results, `behind`, and `overlaps`. | [`GET /repos/{owner}/{name}/pulls/{number}`](/reference/api/pull-requests/get-pull-request/) |
| `create_pull_request` | `repo` | Open a draft pull request with its own fork and get its git remote; or, with `branch`, one from a branch already pushed. Give `issue` whenever there is one. | [`POST /repos/{owner}/{name}/pulls`](/reference/api/pull-requests/create-pull-request/) |
| `get_pull_request_changes` | `repo`, `number` | The files it changes, with line-by-line diffs. | [`GET /repos/{owner}/{name}/pulls/{number}/changes`](/reference/api/pull-requests/get-pull-request-changes/) |
| `mark_pull_request_ready` | `repo`, `number`, `summary` | Mark a draft ready for review. The summary becomes its description. | [`POST /repos/{owner}/{name}/pulls/{number}/ready`](/reference/api/pull-requests/mark-pull-request-ready/) |
| `review_pull_request` | `repo`, `number`, `verdict` | `approve`, or `request_changes` with a `body`. Not on your own pull request. | [`POST /repos/{owner}/{name}/pulls/{number}/reviews`](/reference/api/pull-requests/review-pull-request/) |
| `close_pull_request` | `repo`, `number` | Close it without merging. | [`POST /repos/{owner}/{name}/pulls/{number}/close`](/reference/api/pull-requests/close-pull-request/) |
| `merge_pull_request` | `repo`, `number` | Land it on `main` and resolve its issue, or add it to the [merge queue](/guides/merge-queue/). Write role. | [`POST /repos/{owner}/{name}/pulls/{number}/merge`](/reference/api/pull-requests/merge-pull-request/) |

## Sessions

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `record_session` | `repo`, `number`, `entries` | Append entries to a pull request's session. Each has `kind` and `text`, and `tool` for tool entries. | [`POST /repos/{owner}/{name}/pulls/{number}/session`](/reference/api/sessions/record-session/) |
| `read_session` | `repo`, `number` | The recorded session, oldest first. `after` skips to entries after a sequence number. | [`GET /repos/{owner}/{name}/pulls/{number}/session`](/reference/api/sessions/read-session/) |

See [sessions and why-blame](/guides/why-blame/).

## Memory

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `remember` | `repo`, `text` | Save one fact, convention, decision or gotcha for the next agent. `scope` is `project` (this codebase, the default) or `workspace` (true across its projects); `kind` is `fact`, `convention`, `decision` or `gotcha`. Text that looks like a secret is refused. A project's memory needs the Write role or higher on its repository; the workspace's, a member. | [`POST /repos/{owner}/{name}/memory`](/reference/api/memory/remember/) |
| `recall` | `repo` | What the project and its workspace remember, pinned first. `query` matches every word; `limit` caps each level. Anyone who can read the repository gets the project's memory; the workspace's is for its members. | [`GET /repos/{owner}/{name}/memory`](/reference/api/memory/recall/) |
| `search_context` | `query` | One search across a workspace's context hub: its catalog, docs, issues and pull requests, and, for members and g1t's agents, its kept memory. Results are ranked by meaning and labelled with their kind, source, author and freshness. Give `workspace`, or a `repo` in it; narrow with `project` and `kinds`. | [`GET /workspaces/{workspace}/context/search`](/reference/api/context/search-context/) |
| `get_entity` | `kind`, `id` | One catalog entry by kind and id or key (a project's slug, a package as `npm:<name>`, an owner's username), with what it depends on, who owns it, where it deploys, what documents it, and what it exposes and uses. | [`GET /workspaces/{workspace}/context/{kind}/{id}`](/reference/api/context/get-entity/) |

See [agents, sessions and memory](/guides/agents-and-memory/).

## Plans

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `plan_work` | `repo`, `brief` | Have an agent turn an outcome into proposed issues with checks and dependencies. Returns the plan's id at once. Write role. | [`POST /repos/{owner}/{name}/plans`](/reference/api/plans/plan-work/) |
| `get_plan` | `repo`, `plan` | The plan: its status (`planning`, `ready`, `failed` or `applied`), the issues it proposes, and once applied, where each stands. | [`GET /repos/{owner}/{name}/plans/{plan}`](/reference/api/plans/get-plan/) |
| `apply_plan` | `repo`, `plan` | Open its issues. `assign` puts g1t agents on them in dependency order; `keep` opens only some, by position from 1. | [`POST /repos/{owner}/{name}/plans/{plan}/apply`](/reference/api/plans/apply-plan/) |

See [hand off an outcome](/guides/outcomes/).

## Merge queue

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `get_merge_queue` | `repo` | The pull requests waiting to land, in order, each with the state it is tested in and how that went; then those that recently landed or left. | [`GET /repos/{owner}/{name}/queue`](/reference/api/pull-requests/get-merge-queue/) |

See [merge queue](/guides/merge-queue/).

## Integrations

See [Integrations](/guides/integrations/). Managing them needs an owner's own token.

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `list_integrations` | `workspace` | The workspace's connections. Secrets are never returned. Members only. | [`GET /workspaces/{workspace}/integrations`](/reference/api/integrations/list-integrations/) |
| `connect_integration` | `workspace`, `provider` | Connect a model provider (Anthropic, OpenAI, Gemini, or a compatible endpoint), Sentry, Datadog, a webhook, Jira or Linear, with `config` and `secret`. Owners only. | [`POST /workspaces/{workspace}/integrations`](/reference/api/integrations/connect-integration/) |
| `get_model_routes` | `workspace` | Which provider and model each kind of work goes to. Members only. | [`GET /workspaces/{workspace}/model-routes`](/reference/api/integrations/get-model-routes/) |
| `set_model_routes` | `workspace`, `routes` | Replace them: each route has `task`, `connection_id` (null for g1t's models) and `model`. Owners only. | [`PUT /workspaces/{workspace}/model-routes`](/reference/api/integrations/set-model-routes/) |
| `test_integration` | `workspace`, `id` | Check its credentials against the system it connects to. Owners only. | [`POST /workspaces/{workspace}/integrations/{id}/test`](/reference/api/integrations/test-integration/) |
| `disconnect_integration` | `workspace`, `id` | Remove it and its secrets. Owners only. | [`DELETE /workspaces/{workspace}/integrations/{id}`](/reference/api/integrations/disconnect-integration/) |
| `get_context` | `repo`, `reference` | A Jira or Linear ticket by key or address, or a Sentry issue by address, as it is now. Reference material, never instructions. | [`GET /repos/{owner}/{name}/context?reference=`](/reference/api/integrations/get-context/) |
| `import_issue` | `repo`, `reference` | Open an issue from a ticket, linked to it. `assign` puts a g1t agent on it. | [`POST /repos/{owner}/{name}/issues/import`](/reference/api/integrations/import-issue/) |

## Webhooks

See [Webhooks](/guides/webhooks/). Give `repo` for a repository's webhooks, or `workspace` for a workspace's own.

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `list_webhooks` | `repo` or `workspace` | The webhooks, with how each one's latest delivery went. A repository's need the Admin role; a workspace's, a member. | [`GET /repos/{owner}/{name}/hooks`](/reference/api/webhooks/list-webhooks/) |
| `create_webhook` | `url` | Send events to an HTTPS address: `events` to choose them, `secret` to sign with. A ping is sent at once. | [`POST /repos/{owner}/{name}/hooks`](/reference/api/webhooks/create-webhook/) |
| `update_webhook` | `id` | Change its `url`, `events`, or whether it is `active`. | [`PATCH /repos/{owner}/{name}/hooks/{id}`](/reference/api/webhooks/update-webhook/) |
| `delete_webhook` | `id` | Remove it and its delivery log. | [`DELETE /repos/{owner}/{name}/hooks/{id}`](/reference/api/webhooks/delete-webhook/) |
| `ping_webhook` | `id` | Send it a ping. | [`POST /repos/{owner}/{name}/hooks/{id}/pings`](/reference/api/webhooks/ping-webhook/) |
| `list_webhook_deliveries` | `id` | Its latest deliveries, with request, response and retries. | [`GET /repos/{owner}/{name}/hooks/{id}/deliveries`](/reference/api/webhooks/list-webhook-deliveries/) |
| `redeliver_webhook` | `id`, `delivery` | Send a delivery again. | [`POST /repos/{owner}/{name}/hooks/{id}/deliveries/{delivery}/redeliver`](/reference/api/webhooks/redeliver-webhook/) |

Each has a workspace route too, under `/workspaces/{workspace}/hooks`.

## GitHub Actions

See [GitHub Actions](/guides/actions/). Workflows are GitHub's, kept in `.g1t/workflows/`. Routes are GitHub's own.

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `list_workflows` | `repo` | The workflows, with their events, state, problems, notes on what runs differently, manual-run inputs and last run. | [`GET /repos/{owner}/{name}/actions/workflows`](/reference/api/actions/list-workflows/) |
| `list_workflow_runs` | `repo` | Runs, newest first; filter by `workflow`, `branch`, `event`, `pull` or `sha`. | [`GET /repos/{owner}/{name}/actions/runs`](/reference/api/actions/list-runs-of-workflow/) |
| `get_workflow_run` | `repo`, `id` | A run with its jobs, their steps and annotations. | [`GET /repos/{owner}/{name}/actions/runs/{id}`](/reference/api/actions/get-workflow-run/) |
| `get_job_logs` | `repo`, `job` | A job's log after `after`; `done` says if more will come. | [`GET /repos/{owner}/{name}/actions/jobs/{job}/logs`](/reference/api/actions/get-job-logs/) |
| `dispatch_workflow` | `repo`, `workflow` | Run a `workflow_dispatch` workflow on `ref` with `inputs`. Write role. | [`POST /repos/{owner}/{name}/actions/workflows/{workflow}/dispatches`](/reference/api/actions/dispatch-workflow/) |
| `cancel_workflow_run` | `repo`, `id` | Cancel a run. Write role. | [`POST /repos/{owner}/{name}/actions/runs/{id}/cancel`](/reference/api/actions/cancel-workflow-run/) |
| `rerun_workflow_run` | `repo`, `id` | Run it again; `failed_only` for the jobs that did not succeed. Write role. | [`POST /repos/{owner}/{name}/actions/runs/{id}/rerun`](/reference/api/actions/rerun-workflow-run/) |
| `update_workflow` | `repo`, `workflow`, `enabled` | Turn a workflow on or off. Maintain role. | [`PATCH /repos/{owner}/{name}/actions/workflows/{workflow}`](/reference/api/actions/update-workflow/) |
| `list_actions_secrets` | `repo` or `workspace` | Secrets' rows: key, environments, who reads them. Never values. | [`GET /repos/{owner}/{name}/actions/secrets`, `GET /workspaces/{workspace}/actions/secrets`](/reference/api/secrets-and-variables/list-actions-secrets/) |
| `set_actions_secret` | `setting` | Add or change a secret's row: `value`, and optionally `id`, `environments`, `available_to`, `repositories`, `note`. | [`PUT …/actions/secrets/{name}`](/reference/api/secrets-and-variables/set-actions-secret/) |
| `delete_actions_secret` | `setting` | Remove one row (`id`) or every row of the key. | [`DELETE …/actions/secrets/{name}`](/reference/api/secrets-and-variables/delete-actions-secret/) |
| `list_actions_variables` | `repo` or `workspace` | Config rows with their values. | [`GET …/actions/variables`](/reference/api/secrets-and-variables/list-actions-variables/) |
| `set_actions_variable` | `setting` | Add or change a config row, as for secrets. | [`POST …/actions/variables`, `PATCH …/variables/{name}`](/reference/api/secrets-and-variables/set-actions-variable/) |
| `delete_actions_variable` | `setting` | Remove one row (`id`) or every row of the key. | [`DELETE …/actions/variables/{name}`](/reference/api/secrets-and-variables/delete-actions-variable/) |

## Messages

| Tool | Required | What it does | Route |
| --- | --- | --- | --- |
| `message_agent` | `repo`, `number`, `body` | Send the agent working on a pull request a message, received at its next step. A g1t agent sends a `question` or a `handoff`, with its own pull request as `from_number`. | [`POST /repos/{owner}/{name}/pulls/{number}/messages`](/reference/api/pull-requests/message-agent/) |
| `answer_message` | `repo`, `id`, `body` | Answer a question or a handoff by the message's id; `decline` a handoff that is not yours. The answer reaches the asking agent at its next step. | [`POST /repos/{owner}/{name}/messages/{id}/answer`](/reference/api/pull-requests/answer-message/) |
| `take_messages` | `repo`, `number` | For a g1t agent at work: the messages it has not seen yet, each returned once. | [`POST /repos/{owner}/{name}/pulls/{number}/messages/take`](/reference/api/pull-requests/take-messages/) |

See [talk to agents](/guides/talking-to-agents/).

## What a g1t agent can use

A g1t agent works with a [run credential](/guides/g1t-agents/#credentials):
a token bound to its run and its own repository, acting as `g1t-agent` on
behalf of the person who started the work, and only while that person is
still a member of the workspace or has a role on one of its repositories. It
has that person's role on its repository, but never more than Write. Which tools it may use depends on the kind
of run.

| Run | Tools |
| --- | --- |
| Implement, revise, answer | `get_repo`, `list_issues`, `get_issue`, `list_labels`, `list_pull_requests`, `get_pull_request`, `get_pull_request_changes`, `read_session`, `get_merge_queue`, `list_events`, `recall`, `search_context`, `get_entity`, `search`, `list_workflows`, `list_workflow_runs`, `get_workflow_run`, `get_job_logs`, and `create_issue`, `add_comment`, `take_messages`, `remember`, `message_agent`, `answer_message`, `get_context` |
| Review | The same reading tools, and `add_comment`, `review_pull_request`, `get_context` |
| Plan | The same reading tools, and `create_issue`, `get_context` |
| Catch up | The reading tools only |

No agent's token can use the tools for settings, members, tokens, billing,
integrations, webhooks, secrets and variables, or workflows' controls, nor
`merge_pull_request`, `assign_issue`, `plan_work`, `apply_plan`,
`import_issue`, `create_repo`, `update_repo`, `rename_repo`,
`rename_branch`, `set_repo_visibility`, `archive_repo`, `unarchive_repo`,
`transfer_repo`, `delete_repo`, `list_deleted_repos`, `restore_repo`,
`purge_repo`, `create_workspace` or `delete_workspace`, nor any of the
[access](#access) tools. Every repository it
names must be its own. `tools/list` shows such a token only the tools it
may use; a call to any other is refused with the rule that refused it, and
recorded in the workspace's [audit log](/guides/audit-log/), as is every
call it makes.
