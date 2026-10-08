---
title: Rules
description: Rulesets decide what may happen to a repository's branches and tags, and what a pull request needs before it merges, for people and agents alike.
---

A **ruleset** says what may happen to some of a repository's branches or
tags, and what a pull request into them needs before it merges. Every push,
every merge, and every branch renamed or commit made through g1t is checked
against the rulesets that cover it. Agents, g1t's own included, follow the
same rules as people. Only people, teams, tokens or g1t that a ruleset
lists as able to bypass it are let through.

A ruleset belongs to a repository, or to a workspace. A workspace's ruleset
holds in every repository it selects. When several rulesets cover a branch,
all of their rules hold, so the strictest one wins.

## What a ruleset has

| Part | What it is |
| --- | --- |
| Name | What people call it, up to 100 characters. |
| Enforcement | `active`: its rules hold. `evaluate`: nothing is refused, and every push or merge it would have refused is recorded (see [Insights](#insights)). `disabled`: kept, but not checked. |
| Target | `branch` or `tag`. |
| Branches or tags | `include` and `exclude` patterns. A name is covered when it matches an include pattern and no exclude pattern. |
| Repositories | A workspace's ruleset only: which of its repositories it holds in. |
| Bypass list | Who these rules do not hold for. Nobody is on it unless listed. |
| Rules | What holds, each with its parameters, and whose changes it holds for. |

### Patterns

Branch, tag and repository names are matched with fnmatch patterns:

| Pattern | Matches |
| --- | --- |
| `~DEFAULT_BRANCH` | The repository's default branch, whatever it is called now. |
| `~ALL` | Every branch, tag or repository. |
| `release/*` | `release/1.x`, but not `release/1.x/hotfix`: `*` stays within one segment. |
| `release/**` | Everything under `release/`. |
| `v[0-9]*` | `v1`, `v2.0.1`. `[...]` matches one character of a set; `[!...]` one not in it. |

A pattern written as a full ref, such as `refs/heads/main`, works too. An
empty include list covers nothing.

File path patterns in rules work the same way, with one addition: a
pattern without a `/`, such as `*.exe` or `CODEOWNERS`, matches a file of
that name in any directory. A pattern ending in `/` matches everything
under it.

### Repositories a workspace ruleset holds in

| Condition | What it does |
| --- | --- |
| `include`, `exclude` | Repository name patterns, ignoring case. `~ALL` is every repository. |
| `visibility` | `any`, `public` or `private`. |
| `topics` | Only repositories with at least one of these [topics](/guides/managing-repositories/). Empty means any. |

## Create a ruleset

You need the Admin [role](/guides/access-and-roles/) for a
repository's ruleset. For a workspace's, you need to be an owner.

1. Open the repository's **Settings → Rules**, or the workspace's
   **Settings → Rules**.
2. Choose **New ruleset**.
3. Name it, choose **Branches** or **Tags**, and set which names it covers.
   **Default branch** and **All branches** are a click away.
4. Choose its enforcement. To try it without refusing anything, choose
   **Evaluate** and watch Insights.
5. Add people, teams, roles, tokens or g1t who may bypass it, if anyone.
6. Choose **Add a rule** for each rule. Set its parameters, and whether it
   holds for **Everyone**, **Agents' changes** or **People's changes**.
7. Choose **Create ruleset**.

**Export JSON** downloads a ruleset. **Import JSON** fills the form from a
ruleset file, so one ruleset can be copied to other repositories or
workspaces. The file is the ruleset as the [API](#from-the-api) shows it.

## The rules that hold for a branch

Under **Settings → Rules**, **What holds for a branch** lists every rule of
every ruleset that covers a branch, the repository's and its workspace's,
active ones first. For each ruleset it also shows who may bypass it. To see
a tag's rules, put `?tag=v1.0` in the address.

The **Rules** box on a pull request lists each rule of its base branch it
does not meet yet. For each one it shows which ruleset it comes from and
what to do about it.

## Who may bypass

| Kind | `value` | Who |
| --- | --- | --- |
| `role` | `write`, `maintain`, `admin` (that role or higher), or `owner` | People with that role on the repository, or the workspace's owners. |
| `team` | `team` or `workspace/team` | The team's people, child teams included. |
| `user` | A username | One person. |
| `token` | A token's id, or `workspace` | That access token, or any of the workspace's own tokens. |
| `g1t` | None | g1t's agents, and g1t acting on its own, such as the merge queue and security updates. |

Each entry has a `mode`:

- `always`: pushes and merges both go through.
- `pull_requests`: only merges go through. Their pushes follow the rules.

An agent never gets its person's role. An agent acting for an admin still
follows a ruleset that lets admins bypass it. Only a `g1t` or `token` entry
lets an agent through.

When a person who may bypass merges a pull request that does not meet the
rules, the merge box offers **Bypass the rules**. Through the API, pass
`bypass_rules`. A push from someone on the bypass list goes through by
itself, since git has no box to tick. Every bypass is recorded in
[Insights](#insights).

## Rules

Each rule has a `type` and `parameters`. A parameter you leave out takes its
default. `applies_to` is `everyone` (the default), `agents` or `people`.

A change counts as an agent's when it is pushed with an agent's token, or
when its pull request was made by g1t, opened with an agent's token, or opened
naming an agent (`agent`) through the API or MCP. A pull request a person
opens on the site, or through the API without naming an agent, is a person's.

### Branches and tags

| Rule | `type` | What it does | Parameters |
| --- | --- | --- | --- |
| Restrict creations | `creation` | Only people on the bypass list create matching branches or tags. | None |
| Restrict updates | `update` | Only people on the bypass list push to matching branches or tags. This covers merges too. | None |
| Restrict deletions | `deletion` | Only people on the bypass list delete them. | None |
| Block force pushes | `non_fast_forward` | A push must add to the branch's history, never rewrite it. | None |
| Branch name pattern | `branch_name_pattern` | New branches must be named as it says. | [Pattern](#pattern-rules) |
| Tag name pattern | `tag_name_pattern` | New tags must be named as it says. | [Pattern](#pattern-rules) |

### Pull requests and checks

| Rule | `type` | What it does |
| --- | --- | --- |
| Require a pull request before merging | `pull_request` | Pushes straight to the branch are refused. A pull request into it needs what the parameters say. |
| Require status checks to pass | `required_status_checks` | These checks must pass on a pull request's head before it merges. |
| Require the merge queue | `merge_queue` | Merging into the default branch adds the pull request to the [merge queue](/guides/merge-queue/), with these settings. On other branches it merges directly. |
| Require deployments to succeed | `required_deployments` | A pull request's head must have deployed successfully to these environments: on g1t.page, or anywhere it was reported. |

`pull_request` parameters:

| Parameter | Default | What it does |
| --- | --- | --- |
| `required_approvals` | `0` | Approving reviews needed, 0 to 10. A reviewer who has since asked for changes blocks the merge. Nobody approves their own pull request, or one g1t made for them. |
| `count_agent_approvals` | `true` | Whether an agent's approval counts toward `required_approvals`. |
| `dismiss_stale_reviews_on_push` | `false` | Approvals given before the latest push no longer count. |
| `require_code_owner_review` | `false` | The [code owners](/guides/codeowners/) of every file it changes must approve. |
| `require_last_push_approval` | `false` | Someone other than whoever pushed last must approve after that push. |
| `allowed_merge_methods` | All | `merge`, `squash` or `rebase`. g1t merges by landing the branch as it is, which counts as `merge`. Squash and rebase merging are planned. |
| `allow_direct_pushes` | `false` | Pull requests need what this rule says, but pushes straight to the branch are still allowed. Only the ruleset made from branch protection that did not require pull requests has this on. |

`required_status_checks` parameters:

| Parameter | Default | What it does |
| --- | --- | --- |
| `checks` | None | Each check has a `context`, such as `CI` (a workflow's name) or `g1t / deploy`, and an optional `integration`: `actions`, `deployments`, `security`, `g1t` or `api` (a status or [check run](/guides/checks/) reported through the API). A check with an `integration` counts only when that integration reported it, so a workflow cannot stand in for a deployment. A check is met by a status or a check run of its name alike. |
| `strict` | `false` | The pull request must contain the branch's latest commits, so what merges is exactly what was checked. |
| `paths` | Always | The checks are required only when the pull request changes a file matching one of these patterns. |
| `allow_bypass_on_merge` | `false` | Someone who may merge can merge past checks that have not passed by ticking **Bypass the required checks**. |

`merge_queue` parameters: `max_entries_to_build` (pull requests tested at
once, 1 to 20, default 4), `min_entries_to_merge` and
`min_entries_wait_minutes` (the smallest batch to start, and how long the
oldest entry waits for it to fill; default 1 and 0),
`check_response_timeout_minutes` (how long a batch's checks may take before
it is tested again, 5 to 360, default 45) and `merge_method`. When several
rulesets set a queue, the queue uses the smallest batch size and timeout
and the longest wait among them.

`required_deployments` takes `environments`. `preview` is a pull request's
[preview deployment](/guides/deployments/). A project's slug is that
project's deployment, when a repository has several. Any other name is an
environment [deployments are reported to](/guides/deployments-api/), from
any CI or by a g1t Actions job with an `environment:`: a successful
`deploy / <environment>` check on the head meets it, such as
`deploy / staging` for `staging`. Names are matched without regard to case.

### Commits

| Rule | `type` | What it does |
| --- | --- | --- |
| Require linear history | `required_linear_history` | No merge commits. Rebase instead of merging the branch in. |
| Require signed commits | `required_signatures` | Every commit carries a signature g1t verifies. |
| Commit message pattern | `commit_message_pattern` | Every commit message must match, or must not. |
| Commit author email pattern | `commit_author_email_pattern` | Every author address must match, or must not. |
| Committer email pattern | `committer_email_pattern` | Every committer address must match, or must not. |

These hold for the commits a push adds and for the commits a pull request
would land when it merges.

**Signed commits.** g1t verifies SSH signatures made with an ed25519 key:

```sh
git config gpg.format ssh
git config user.signingkey ~/.ssh/id_ed25519.pub
git commit -S -m "Add rules"
```

A signature counts as verified when it is valid over the commit and the key
is one of the [SSH keys](/guides/authentication/) on the g1t account that
owns the committer's verified email address. GPG signatures, and SSH
signatures made with RSA or ECDSA keys, are reported as not verified yet.
Commits g1t makes itself, such as catching a pull request up and web edits,
are not signed. So with this rule on a branch, bring pull requests up to
date with a signed rebase of your own.

### Pattern rules

| Parameter | What it does |
| --- | --- |
| `operator` | `starts_with`, `ends_with`, `contains` or `regex`. |
| `pattern` | The text, or the regular expression. |
| `negate` | The text must not match. |
| `name` | What the rule is called in refusals, such as `Conventional commits`. |

Regular expressions run on a linear-time engine. A pattern can never make a
push slow, and look-around and back-references are not supported. For
example, conventional commits:

```json
{ "type": "commit_message_pattern", "parameters": { "name": "Conventional commits", "operator": "regex", "pattern": "^(feat|fix|docs|chore)(\\(.+\\))?: " } }
```

### Files

| Rule | `type` | What it does | Parameters |
| --- | --- | --- | --- |
| Restrict file paths | `file_path_restriction` | Changes to matching paths are refused, deletions included. | `restricted_file_paths` |
| Restrict file extensions | `file_extension_restriction` | Files with these extensions may not be added or changed. | `restricted_file_extensions`, such as `.exe` |
| Restrict file size | `max_file_size` | No file larger than this. | `max_file_size_mb`, 1 to 100 |
| Restrict file path length | `max_file_path_length` | No path longer than this. | `max_file_path_length` |
| Restrict files changed | `max_files_changed` | A commit may change at most this many files. | `max_files` |
| Block pushes that add secrets | `secret_scanning` | Every push to the branch is scanned by [push protection](/guides/security/secret-protection/). A push too large to scan is refused rather than let through unscanned. | None |

### Agents, review and timing

These rules exist for teams where agents write much of the code.

| Rule | `type` | What it does | Parameters |
| --- | --- | --- | --- |
| Confidence threshold | `confidence_threshold` | An agent's change that g1t [rates](/guides/working-with-g1t/#how-sure-the-agent-is) below `minimum` needs approvals from people before it merges. A change not rated yet counts as below. | `minimum` (`low`, `medium`, `high`), `required_approvals` |
| Cost cap | `cost_cap` | Once agents have spent more than `max_usd` on a pull request, it does not merge, and its agent is not sent back to revise, until a person approves it. | `max_usd` |
| Review for sensitive paths | `path_review` | A pull request that changes a matching file needs approvals from people since its latest push, from `team` when one is named. | `paths`, `required_approvals`, `team` |
| Merge window | `merge_window` | When pull requests may merge into the branch. | See below |
| Agent auto-merge | `agent_auto_merge` | Whether g1t lands an agent's ready pull request into the branch without a person, and how sure g1t must be first. The repository's **Merge automatically when ready** setting must be on too. | `allowed`, `minimum_confidence` |

Rules that hold only for agents' changes cover the rest of what an
agent-first team needs. For example:

- Agents' pull requests need one approval from a person: `pull_request`
  with `required_approvals` `1`, `count_agent_approvals` `false`, and
  `applies_to` `agents`.
- Agents may not change workflows or code owners: `file_path_restriction`
  with `.g1t/workflows/**` and `CODEOWNERS`, and `applies_to` `agents`.

`merge_window` parameters:

| Parameter | What it does |
| --- | --- |
| `time_zone` | A fixed offset from UTC, such as `+02:00` or `-05:00`, or `UTC`. Daylight saving time is not applied. |
| `windows` | Weekly hours when merging is open: each has `days` (`mon` to `sun`), `start` and `end` as `HH:MM`. An `end` before its `start` runs past midnight. With none, merging is open whenever no freeze covers the moment. |
| `freezes` | Periods when merging waits, each with `start`, `end` (RFC 3339) and a `reason`. A freeze without an `end` lasts until you remove it. Use one during an incident. **Freeze now, until lifted** adds one. |
| `exceptions` | Periods when merging is open whatever the windows and freezes say, such as a hotfix. |

A refusal outside the window says when it next opens.

## Evaluate mode

A ruleset in `evaluate` refuses nothing. Every push and merge it would have
refused is recorded as **Would block** in Insights. On a pull request, the
merge box lists what it would refuse under **Rulesets in evaluate would
refuse it**. Turn a ruleset to **Active** once Insights shows it refusing
only what it should.

## Insights

**Settings → Rules → Insights** lists how the rules judged each push, merge,
branch creation, deletion, rename and commit made on the site, newest first.
Each entry shows the ruleset, the ref, who made the change, whether they are
a person or an agent, and every rule broken with the reason. Totals cover
the last 30 days: **Passed**, **Blocked** (refused by an active ruleset),
**Would block** and **Bypassed**, with the rules broken most. A workspace's
Insights covers all of its repositories. Evaluations are kept for 90 days.

Changing a ruleset is recorded in the workspace's
[audit log](/guides/audit-log/) and sent to webhooks as `ruleset.created`,
`ruleset.updated` or `ruleset.deleted`. A workspace's ruleset events go to
the workspace's webhooks.

## Where rules are checked

| Change | What happens |
| --- | --- |
| `git push` | The rules of every branch and tag the push changes are checked before anything is stored. A refused push changes nothing, and git prints why. |
| Merging a pull request | The merge button, the API, MCP, auto-merge, g1t's own merges and the merge queue all check the same rules. |
| Renaming a branch | Covered as deleting the old name and creating the new one. |
| A file committed on the site | Covered as a push of that commit to its new branch. |
| Bringing a pull request up to date | Covered as a push of the merge commit to its branch. |

A refused push looks like this:

```text
remote:
remote: error: rules for refs/heads/main declined this push:
remote: - Changes to main must be made through a pull request. [ruleset "Protect main", pull_request]
remote:   Push a branch, open a pull request into main, and merge it.
remote: See the rules that hold for it: https://g1t.sh/acme/web/settings/rules?branch=main
remote:
 ! [remote rejected] main -> main (declined by ruleset "Protect main" (pull_request))
```

A pull request's fork, where g1t's agents work, has no rules of its own.
What it brings is checked against the base branch's rules when it merges.

## Rulesets and branch protection

Before rulesets, a repository had one set of protection settings for its
default branch. Each repository's settings became a ruleset named
**Default branch protection**, targeting `~DEFAULT_BRANCH` and holding
exactly what they held:

| Setting | Becomes |
| --- | --- |
| Require a pull request to change the default branch | `pull_request` |
| Required approvals, g1t's approval counts, require review from code owners | `pull_request`'s `required_approvals`, `count_agent_approvals`, `require_code_owner_review` |
| Required status checks, require branches to be up to date, allow bypassing required checks | `required_status_checks`'s `checks`, `strict`, `allow_bypass_on_merge` |
| Merge through a queue | `merge_queue` |

Where approvals or code owners were required but pushes were not refused,
the `pull_request` rule has `allow_direct_pushes` on, so pushes still go
through as before.

Pull requests into other branches used to need nothing. Now they need what
the rulesets covering their base ask for. With only the migrated ruleset,
that is still nothing.

[`update_repo_settings`](/reference/api/repositories/update-repo-settings/)
still takes the old fields and writes them to the **Default branch
protection** ruleset, creating it when needed. Rules only rulesets have
stay as they are. [`get_repo_settings`](/reference/api/repositories/get-repo-settings/)
returns the default branch's protection as all of its rulesets stack. The
`protected` field of [`update_repo`](/reference/api/repositories/update-repo/)
turns the ruleset's pull request requirement on or off.

## From the API

| Route | MCP | What it does |
| --- | --- | --- |
| `GET /repos/{owner}/{name}/rulesets` | `repository` `list_rulesets` | A repository's rulesets; `include_parents` adds the workspace's that hold in it. |
| `POST /repos/{owner}/{name}/rulesets` | `repository` `create_ruleset` | Create one. |
| `GET /repos/{owner}/{name}/rulesets/{id}` | `repository` `get_ruleset` | One ruleset. |
| `PUT /repos/{owner}/{name}/rulesets/{id}` | `repository` `update_ruleset` | Change one. Fields you leave out stay as they are. |
| `DELETE /repos/{owner}/{name}/rulesets/{id}` | `repository` `delete_ruleset` | Delete one. |
| `GET /repos/{owner}/{name}/rules/branches/{branch}` | `repository` `branch_rules` | Every rule that holds for a branch (`?target=tag` for a tag). Encode slashes: `release%2F1.x`. |
| `GET /repos/{owner}/{name}/rules/evaluations` | `repository` `rule_evaluations` | Evaluations and insights; `ruleset_id`, `verdict`, `problems_only`, `before`, `limit`. |
| `/workspaces/{workspace}/rulesets` and `/workspaces/{workspace}/rules/evaluations` | `workspace` `list_rulesets` and the rest | The same for a workspace. |

The body of a create or update is the ruleset. Under a repository's
address, `name` already names the repository, so the ruleset's name is
`ruleset_name`. A file exported from the site, which says `name`, is read as
it is.

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/rulesets \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ruleset_name": "Protect main",
    "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"] } },
    "bypass_actors": [{ "kind": "role", "value": "admin", "mode": "pull_requests" }],
    "rules": [
      { "type": "deletion" },
      { "type": "non_fast_forward" },
      { "type": "pull_request", "parameters": { "required_approvals": 1, "dismiss_stale_reviews_on_push": true } },
      { "type": "required_status_checks", "parameters": { "checks": [{ "context": "CI", "integration": "actions" }], "strict": true } },
      { "type": "pull_request", "parameters": { "required_approvals": 1, "count_agent_approvals": false }, "applies_to": "agents" },
      { "type": "file_path_restriction", "parameters": { "restricted_file_paths": [".g1t/workflows/**"] }, "applies_to": "agents" }
    ]
  }'
```

Reading rulesets takes the `repo:read` or `workspace:read`
[scope](/guides/authentication/). Changing them takes `repo:admin` or
`workspace:admin`, since it changes what everyone, agents included, may do.
[`merge_pull_request`](/reference/api/pull-requests/merge-pull-request/)
takes `bypass_rules`. [`get_pull_request`](/reference/api/pull-requests/get-pull-request/)
returns `rules`: what is `unmet`, what you may bypass (`bypassable`),
and what rulesets in evaluate would refuse (`evaluate`).

Every operation is in the [API reference](/reference/api/rules/list-repo-rulesets/).
