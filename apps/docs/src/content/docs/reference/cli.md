---
title: CLI commands
description: Every g1t command with its arguments and flags, written from the CLI's own definitions.
---

<!-- Generated from crates/g1t by `G1T_WRITE_DOCS=1 cargo test -p g1t cli_reference`. Do not edit by hand. -->

Every command of the [g1t CLI](/guides/cli/), with its arguments and flags.
`g1t <command> --help` prints the same at a terminal. Each command that talks
to the API names the operations it calls, which link to the
[API reference](/reference/api/); [`g1t api`](#g1t-api) calls any other.

## Flags every command takes

| Flag | |
| --- | --- |
| `-R, --repo <[HOST/]OWNER/NAME>` | The repository, as [HOST/]OWNER/NAME, instead of the current directory's. Also `G1T_REPO`. |
| `--hostname <HOST>` | The g1t host, such as g1t.sh or git.example.com. |
| `--json [FIELDS]` | Print JSON: every field, or only the comma-separated FIELDS. |
| `--jq <EXPRESSION>` | Run a jq expression over the JSON and print what it gives. |

## g1t auth

Sign in, sign out, and set git up to use g1t's credentials.

### g1t auth login

Sign in to a g1t host.

```text
g1t auth login [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `--with-token` | Read a token from stdin instead of approving in the browser. |
| `--insecure-storage` | Keep the token in the config file, not the system keychain. |
| `--no-browser` | Do not open the browser; just print the link. |
| `--git` | Also set git up to use g1t's credentials (see `g1t auth setup-git`). |

```text
Without --with-token, g1t shows a code and a link; approve it in the browser, signed in.
With --with-token, the token is read from stdin:
  g1t auth login --with-token < token.txt
```

Calls [`device_code`](/reference/api/accounts/device-code/), [`device_token`](/reference/api/accounts/device-token/), [`whoami`](/reference/api/accounts/whoami/).

### g1t auth logout

Sign out of an account on a host.

```text
g1t auth logout [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-u, --user <USER>` | The account, when more than one is signed in on the host. |

### g1t auth status

Show which accounts are signed in, and whether their tokens work.

```text
g1t auth status [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `--show-token` | Print each token too. |

Calls [`whoami`](/reference/api/accounts/whoami/).

### g1t auth token

Print the token in use, for another program.

```text
g1t auth token [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-u, --user <USER>` | The account, when more than one is signed in on the host. |

### g1t auth switch

Make another signed-in account on a host the active one.

```text
g1t auth switch [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-u, --user <USER>` | The account, when more than one is signed in on the host. |

### g1t auth setup-git

Make git use g1t's credentials for pushing and fetching over HTTPS.

```text
g1t auth setup-git [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `--dry-run` | Print the git config commands instead of running them. |

## g1t repo

Repositories: view, clone, create, list, fork, sync.

### g1t repo view

Show a repository.

```text
g1t repo view [OPTIONS] [REPOSITORY]
```

| Argument or flag | |
| --- | --- |
| `[REPOSITORY]` | OWNER/NAME; the current repository when left out. |
| `-w, --web` | Open it in the browser. |

Calls [`get_repo`](/reference/api/repositories/get-repo/), [`list_projects`](/reference/api/projects/list-projects/).

### g1t repo clone

Clone a repository.

```text
g1t repo clone [OPTIONS] <REPOSITORY> [DIRECTORY] [-- <GIT_FLAGS>...]
```

| Argument or flag | |
| --- | --- |
| `<REPOSITORY>` | OWNER/NAME, or NAME for one of your own. |
| `[DIRECTORY]` | Where to clone it. |
| `[GIT_FLAGS]` | After `--`. Flags for git clone, after --. |

Calls [`whoami`](/reference/api/accounts/whoami/).

### g1t repo create

Make a repository.

```text
g1t repo create [OPTIONS] [NAME]
```

| Argument or flag | |
| --- | --- |
| `[NAME]` | NAME, or WORKSPACE/NAME. |
| `--public` | Anyone can see it. Repositories are private unless this is given. |
| `--private` | Only people with a role on it can see it (the default). |
| `-d, --description <DESCRIPTION>` | What it is, in a line: its project's description. |
| `-c, --clone` | Clone it once it is made. |
| `--source <DIR>` | Add it as a remote of this directory's repository and push it there. |
| `--remote <REMOTE>` | The remote's name, with --source. Default: `origin`. |
| `--deploy` | Turn on its g1t.page deployments once it is made, so its first push deploys production. |

Calls [`create_repo`](/reference/api/repositories/create-repo/).

### g1t repo list

List repositories you can see.

```text
g1t repo list [OPTIONS] [WORKSPACE]
```

| Argument or flag | |
| --- | --- |
| `[WORKSPACE]` | Only this workspace's. |
| `-q, --query <QUERY>` | Only those whose name holds this. |
| `-L, --limit <LIMIT>` | Default: `20`. |

Calls [`list_repos`](/reference/api/repositories/list-repos/), [`list_projects`](/reference/api/projects/list-projects/).

### g1t repo fork

Fork a repository into one of your workspaces.

```text
g1t repo fork [OPTIONS] [REPOSITORY]
```

| Argument or flag | |
| --- | --- |
| `[REPOSITORY]` | OWNER/NAME; the current repository when left out. |
| `-w, --workspace <WORKSPACE>` | The workspace to fork it into; your personal workspace when left out. |
| `--name <NAME>` | The fork's name; the repository's own when left out. |
| `--all-branches` | Copy every branch and tag, not only the default branch. |
| `-c, --clone` | Clone the fork, with the repository it came from as the remote upstream. |

Calls [`fork_repo`](/reference/api/repositories/fork-repo/).

### g1t repo forks

List a repository's forks.

```text
g1t repo forks [OPTIONS] [REPOSITORY]
```

| Argument or flag | |
| --- | --- |
| `[REPOSITORY]` | OWNER/NAME; the current repository when left out. |
| `-L, --limit <LIMIT>` | Default: `30`. |

Calls [`list_forks`](/reference/api/repositories/list-forks/), [`list_projects`](/reference/api/projects/list-projects/).

### g1t repo sync

Bring a fork's branch up to date with the repository it was forked from.

```text
g1t repo sync [OPTIONS] [REPOSITORY]
```

| Argument or flag | |
| --- | --- |
| `[REPOSITORY]` | The fork, OWNER/NAME; the one this directory pushes to (origin) when left out. |
| `-b, --branch <BRANCH>` | The fork's branch to sync; its default branch when left out. |

Calls [`sync_fork`](/reference/api/repositories/sync-fork/).

### g1t repo detach

Make a fork an ordinary repository, no longer linked to its parent.

```text
g1t repo detach [OPTIONS] [REPOSITORY]
```

| Argument or flag | |
| --- | --- |
| `[REPOSITORY]` | The fork, OWNER/NAME; the one this directory pushes to (origin) when left out. |
| `-y, --yes` | Do not ask first. |

Calls [`detach_fork`](/reference/api/repositories/detach-fork/).

## g1t pr

Pull requests: list, view, create, check out, diff, checks, review, merge.

### g1t pr list

List pull requests.

```text
g1t pr list [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-s, --state <STATE>` | One of `open`, `closed`, `merged`, `all`. Default: `open`. |
| `-B, --base <BASE>` | Only those merging into this branch. |
| `-l, --label <LABEL>` |  |
| `-A, --author <AUTHOR>` | Only those opened by this person (@me for you). |
| `-d, --draft` | Only drafts. |
| `-L, --limit <LIMIT>` | Default: `20`. |

Calls [`list_pull_requests`](/reference/api/pull-requests/list-pull-requests/).

### g1t pr view

Show a pull request.

```text
g1t pr view [OPTIONS] [NUMBER]
```

| Argument or flag | |
| --- | --- |
| `[NUMBER]` | The number; the current branch's when left out. |
| `-c, --comments` |  |
| `-w, --web` |  |

Calls [`get_pull_request`](/reference/api/pull-requests/get-pull-request/), [`list_pull_requests`](/reference/api/pull-requests/list-pull-requests/).

### g1t pr create

Open a pull request from a branch, or start one for a work item.

```text
g1t pr create [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-t, --title <TITLE>` |  |
| `-b, --body <BODY>` | The text. Markdown. |
| `-F, --body-file <FILE>` | Read the text from a file, or - for stdin. |
| `--attach <FILE>` | An image to show after the text (PNG, JPEG, GIF or WebP, at most 10 MB): uploaded, and its Markdown added. Repeat for more. |
| `-B, --base <BASE>` | The branch to merge into; the default branch when left out. |
| `-H, --head <HEAD>` | The branch with the changes; the current one when left out. |
| `-i, --item <ITEM>` | The work item it is for, by its number in the workspace. Without a branch, starts a draft in a working copy of its own. |
| `-f, --fill` | Take the title and body from the branch's commits. |
| `-d, --draft` | Open it as a draft. |
| `--no-push` | Do not push the branch first. |
| `--head-repo <OWNER/NAME>` | The fork, OWNER/NAME, that holds the branch. In a clone of your fork (origin) whose upstream is the repository, origin when left out. |

Calls [`create_pull_request`](/reference/api/pull-requests/create-pull-request/), [`get_repo`](/reference/api/repositories/get-repo/), [`convert_pull_request_to_draft`](/reference/api/pull-requests/convert-pull-request-to-draft/), [`upload_attachment`](/reference/api/work-items/upload-attachment/).

### g1t pr checkout

Check a pull request's changes out locally.

```text
g1t pr checkout [OPTIONS] <NUMBER>
```

| Argument or flag | |
| --- | --- |
| `<NUMBER>` |  |
| `-b, --branch <BRANCH>` | The local branch's name; pr-NUMBER when left out. |
| `-f, --force` | Reset the local branch to the pull request's head even if it has other commits. |

Calls [`get_pull_request`](/reference/api/pull-requests/get-pull-request/).

### g1t pr diff

Show a pull request's changes as a diff.

```text
g1t pr diff [OPTIONS] [NUMBER]
```

| Argument or flag | |
| --- | --- |
| `[NUMBER]` |  |
| `--name-only` | Only the changed files' names. |
| `--color <COLOR>` | Color: auto, always or never. Default: `auto`. |

Calls [`get_pull_request_changes`](/reference/api/pull-requests/get-pull-request-changes/).

### g1t pr checks

Show a pull request's checks; --watch waits for them.

```text
g1t pr checks [OPTIONS] [NUMBER]
```

| Argument or flag | |
| --- | --- |
| `[NUMBER]` |  |
| `-w, --watch` | Wait until every check has finished. |
| `--fail-fast` | With --watch, stop at the first failing check. |
| `-i, --interval <INTERVAL>` | Seconds between looks, with --watch. Default: `10`. |

Calls [`get_pull_request`](/reference/api/pull-requests/get-pull-request/), [`list_check_runs_for_ref`](/reference/api/checks/list-check-runs-for-ref/), [`get_combined_status`](/reference/api/checks/get-combined-status/).

### g1t pr review

Approve a pull request, or ask for changes.

```text
g1t pr review [OPTIONS] <--approve|--request-changes|--comment> [NUMBER]
```

| Argument or flag | |
| --- | --- |
| `[NUMBER]` |  |
| `-a, --approve` |  |
| `-r, --request-changes` |  |
| `-c, --comment` | Comment without approving or asking for changes. |
| `-b, --body <BODY>` | The text. Markdown. |
| `-F, --body-file <FILE>` | Read the text from a file, or - for stdin. |

Calls [`review_pull_request`](/reference/api/pull-requests/review-pull-request/), [`add_comment`](/reference/api/pull-requests/add-comment/).

### g1t pr merge

Merge a pull request, now or with auto-merge.

```text
g1t pr merge [OPTIONS] [NUMBER]
```

| Argument or flag | |
| --- | --- |
| `[NUMBER]` |  |
| `-m, --merge` | Merge with a merge commit. The repository's default method when no method is given. |
| `-s, --squash` | Squash its commits into one. |
| `-r, --rebase` | Make each of its commits again on top of the base. |
| `--ff` | Fast-forward: move the base to its head, with no new commit. |
| `-t, --subject <SUBJECT>` | The merge or squash commit's title; the repository's default when left out. |
| `-b, --body <BODY>` | The text. Markdown. |
| `-F, --body-file <FILE>` | Read the text from a file, or - for stdin. |
| `--auto` | Merge on its own once its checks, reviews and rules allow. |
| `--disable-auto` | Turn its auto-merge off. |
| `--keep-item-open` | Do not land the work item it is for: it is only part of the work. |
| `--admin` | Merge past failing required checks and rules (needs the Admin role). |
| `-d, --delete-branch` | Delete its branch once merged, and the local branch. The repository's setting when left out. |
| `--keep-branch` | Keep its branch, whatever the repository's setting. |
| `--match-head-commit <SHA>` | Refuse to merge unless its head is still this commit. |

Calls [`merge_pull_request`](/reference/api/pull-requests/merge-pull-request/), [`enable_pull_request_auto_merge`](/reference/api/pull-requests/enable-pull-request-auto-merge/), [`disable_pull_request_auto_merge`](/reference/api/pull-requests/disable-pull-request-auto-merge/).

### g1t pr update-branch

Bring a pull request's branch up to date with its base.

```text
g1t pr update-branch [OPTIONS] [NUMBER]
```

| Argument or flag | |
| --- | --- |
| `[NUMBER]` | The number; the current branch's when left out. |
| `--rebase` | Rebase its commits onto the base instead of merging the base in. Rewrites its branch. |

Calls [`update_pull_request_branch`](/reference/api/pull-requests/update-pull-request-branch/).

### g1t pr ready

Mark a draft ready for review, or turn it back into a draft.

```text
g1t pr ready [OPTIONS] [NUMBER]
```

| Argument or flag | |
| --- | --- |
| `[NUMBER]` |  |
| `-s, --summary <SUMMARY>` | What changed and why; it becomes the description. The current one when left out. |
| `--attach <FILE>` | An image to show after the summary (PNG, JPEG, GIF or WebP, at most 10 MB): uploaded, and its Markdown added. Repeat for more. |
| `--undo` | Turn it back into a draft. |

Calls [`mark_pull_request_ready`](/reference/api/pull-requests/mark-pull-request-ready/), [`convert_pull_request_to_draft`](/reference/api/pull-requests/convert-pull-request-to-draft/), [`upload_attachment`](/reference/api/work-items/upload-attachment/).

### g1t pr comment

Comment on a pull request.

```text
g1t pr comment [OPTIONS] [NUMBER]
```

| Argument or flag | |
| --- | --- |
| `[NUMBER]` | The pull request's number; the current branch's when left out. |
| `-b, --body <BODY>` | The text. Markdown. |
| `-F, --body-file <FILE>` | Read the text from a file, or - for stdin. |
| `--attach <FILE>` | An image to show after the text (PNG, JPEG, GIF or WebP, at most 10 MB): uploaded, and its Markdown added. Repeat for more. |

Calls [`add_comment`](/reference/api/pull-requests/add-comment/), [`upload_attachment`](/reference/api/work-items/upload-attachment/).

### g1t pr close

Close a pull request without merging it.

```text
g1t pr close [OPTIONS] [NUMBER]
```

| Argument or flag | |
| --- | --- |
| `[NUMBER]` | The number; the current branch's when left out. |

Calls [`close_pull_request`](/reference/api/pull-requests/close-pull-request/).

### g1t pr reopen

Reopen a closed pull request.

```text
g1t pr reopen [OPTIONS] [NUMBER]
```

| Argument or flag | |
| --- | --- |
| `[NUMBER]` | The number; the current branch's when left out. |

Calls [`reopen_pull_request`](/reference/api/pull-requests/reopen-pull-request/).

## g1t run

Workflow runs: list, view, watch, logs, rerun, cancel.

### g1t run list

List workflow runs, newest first.

```text
g1t run list [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-w, --workflow <WORKFLOW>` | Only this workflow's: its file name or id. |
| `-b, --branch <BRANCH>` |  |
| `-e, --event <EVENT>` | Only runs for this event: push, pull_request, schedule... |
| `-c, --commit <COMMIT>` | Only runs of this commit. |
| `--pr <PR>` | Only runs for this pull request. |
| `-L, --limit <LIMIT>` | Default: `20`. |

Calls [`list_workflow_runs`](/reference/api/actions/list-workflow-runs/).

### g1t run view

Show a run's jobs and steps.

```text
g1t run view [OPTIONS] [RUN]
```

| Argument or flag | |
| --- | --- |
| `[RUN]` |  |
| `-j, --job <JOB>` | Show this job's steps only. |
| `--log` | Print the log too. |
| `--log-failed` | Print the failing steps' logs too. |
| `-w, --web` |  |
| `--exit-status` | Exit 1 when the run failed. |

Calls [`get_workflow_run`](/reference/api/actions/get-workflow-run/), [`get_job_logs`](/reference/api/actions/get-job-logs/).

### g1t run watch

Follow a run until it finishes; exits 1 if it fails.

```text
g1t run watch [OPTIONS] [RUN]
```

| Argument or flag | |
| --- | --- |
| `[RUN]` |  |
| `-i, --interval <INTERVAL>` | Seconds between looks. Default: `3`. |

Calls [`get_workflow_run`](/reference/api/actions/get-workflow-run/).

### g1t run logs

Print a run's logs; --failed prints only the failing steps' tails.

```text
g1t run logs [OPTIONS] [RUN]
```

| Argument or flag | |
| --- | --- |
| `[RUN]` |  |
| `-j, --job <JOB>` | Only this job's (its id, key or name). |
| `-f, --failed` | Only the failing steps, and only their last lines. |
| `-n, --tail <TAIL>` | How many lines of each failing step to print, with --failed. Default: `60`. |

Calls [`get_workflow_run`](/reference/api/actions/get-workflow-run/), [`get_job_logs`](/reference/api/actions/get-job-logs/).

### g1t run rerun

Run a run again: all of it, its failed jobs, or one job.

```text
g1t run rerun [OPTIONS] [RUN]
```

| Argument or flag | |
| --- | --- |
| `[RUN]` |  |
| `--failed` | Only the jobs that failed. |
| `-j, --job <JOB>` | Only this job (its id). |
| `-d, --debug` | With debug logging. |

Calls [`rerun_workflow_run`](/reference/api/actions/rerun-workflow-run/), [`rerun_failed_jobs`](/reference/api/actions/rerun-failed-jobs/), [`rerun_job`](/reference/api/actions/rerun-job/).

### g1t run cancel

Cancel a run.

```text
g1t run cancel [OPTIONS] [RUN]
```

| Argument or flag | |
| --- | --- |
| `[RUN]` | The run's id (run_…) or number; the current branch's latest when left out. |

Calls [`cancel_workflow_run`](/reference/api/actions/cancel-workflow-run/).

## g1t workflow

Workflows in .g1t/workflows: list, view, run, enable, disable.

### g1t workflow list

List the workflows in .g1t/workflows, with whether each is on.

```text
g1t workflow list [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-a, --all` | Include the workflows that are turned off. |
| `-L, --limit <LIMIT>` | Default: `50`. |

Calls [`list_workflows`](/reference/api/actions/list-workflows/).

### g1t workflow view

Show a workflow and its latest runs; --yaml prints its file.

```text
g1t workflow view [OPTIONS] [WORKFLOW]
```

| Argument or flag | |
| --- | --- |
| `[WORKFLOW]` | Its file name (ci.yml), id (wfl_…) or name; asked for at a terminal when left out. |
| `-y, --yaml` | Print the workflow's file. |
| `-g, --ref <REF>` | The branch or tag to read the file on, with --yaml; the default branch when left out. |
| `-w, --web` | Open it in the browser. |

Calls [`list_workflows`](/reference/api/actions/list-workflows/), [`get_workflow`](/reference/api/actions/get-workflow/), [`list_workflow_runs`](/reference/api/actions/list-workflow-runs/).

### g1t workflow run

Run a workflow that has `on: workflow_dispatch`, and print its run's address.

```text
g1t workflow run [OPTIONS] [WORKFLOW]
```

| Argument or flag | |
| --- | --- |
| `[WORKFLOW]` | Its file name (ci.yml), id (wfl_…) or name; asked for at a terminal when left out. |
| `-g, --ref <REF>` | The branch or tag to run it on; the default branch when left out. |
| `-f, --raw-field <KEY=VALUE>` | An input, key=value; repeat for more. |
| `-F, --field <KEY=VALUE>` | An input, key=value, where @FILE reads the value from a file (@- from stdin). |

```text
Inputs are given with -f (or -F, where @FILE reads a file), or as a JSON object on
stdin with --json. At a terminal, with none given, g1t asks for each input.

Examples:
  g1t workflow run release.yml
  g1t workflow run release.yml --ref v1.4.0 -f channel=stable -f dry_run=true
  echo '{"channel":"stable"}' | g1t workflow run Release --json
```

Calls [`list_workflows`](/reference/api/actions/list-workflows/), [`dispatch_workflow`](/reference/api/actions/dispatch-workflow/), [`list_workflow_runs`](/reference/api/actions/list-workflow-runs/).

### g1t workflow enable

Turn a workflow on again.

```text
g1t workflow enable [OPTIONS] [WORKFLOW]
```

| Argument or flag | |
| --- | --- |
| `[WORKFLOW]` | Its file name (ci.yml), id (wfl_…) or name; asked for at a terminal when left out. |

Calls [`list_workflows`](/reference/api/actions/list-workflows/), [`enable_workflow`](/reference/api/actions/enable-workflow/).

### g1t workflow disable

Turn a workflow off: its file stays, and nothing starts it until it is turned on.

```text
g1t workflow disable [OPTIONS] [WORKFLOW]
```

| Argument or flag | |
| --- | --- |
| `[WORKFLOW]` | Its file name (ci.yml), id (wfl_…) or name; asked for at a terminal when left out. |

Calls [`list_workflows`](/reference/api/actions/list-workflows/), [`disable_workflow`](/reference/api/actions/disable-workflow/).

## g1t secret

Secrets for workflows and deployments, a repository's or a workspace's.

### g1t secret list

List secrets' names (never their values).

```text
g1t secret list [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-w, --workspace <WORKSPACE>` | A workspace's secrets instead of the repository's. |
| `-e, --env <ENVIRONMENT>` | Only the value for this environment (production, preview...). |

Calls [`list_actions_secrets`](/reference/api/secrets-and-variables/list-actions-secrets/), [`list_actions_secrets_for_workspace`](/reference/api/secrets-and-variables/list-actions-secrets-for-workspace/).

### g1t secret set

Set a secret. The value is read from stdin when not given.

```text
g1t secret set [OPTIONS] <NAME>
```

| Argument or flag | |
| --- | --- |
| `<NAME>` | The secret's name; uppercased. |
| `-b, --body <BODY>` | The value. Read from stdin when left out, so it stays out of your shell's history. |
| `-w, --workspace <WORKSPACE>` | A workspace's secrets instead of the repository's. |
| `-e, --env <ENVIRONMENT>` | Only the value for this environment (production, preview...). |
| `--available-to <WHO>` | Who can read it: workflows, deployments, or both (repeat). |
| `--brokered-host <HOST>` | Broker it: jobs get a stand-in, and g1t fills the value in only on requests to this host. Repeat for more. |
| `--note <NOTE>` | A note for whoever reads the list. |

Calls [`set_actions_secret`](/reference/api/secrets-and-variables/set-actions-secret/), [`set_actions_secret_for_workspace`](/reference/api/secrets-and-variables/set-actions-secret-for-workspace/).

### g1t secret delete

Delete a secret.

```text
g1t secret delete [OPTIONS] <NAME>
```

| Argument or flag | |
| --- | --- |
| `<NAME>` |  |
| `-w, --workspace <WORKSPACE>` | A workspace's secrets instead of the repository's. |
| `-e, --env <ENVIRONMENT>` | Only the value for this environment (production, preview...). |

Calls [`delete_actions_secret`](/reference/api/secrets-and-variables/delete-actions-secret/), [`delete_actions_secret_for_workspace`](/reference/api/secrets-and-variables/delete-actions-secret-for-workspace/).

## g1t cache

The repository's actions/cache entries: list, usage, delete.

### g1t cache list

List the repository's cache entries, least recently used last.

```text
g1t cache list [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-k, --key <KEY>` | Only entries whose key starts with this. |
| `-g, --ref <REF>` | Only entries saved by this ref's runs, e.g. refs/heads/main. |
| `-S, --sort <SORT>` | One of `last-accessed-at`, `created-at`, `size-in-bytes`. Default: `last-accessed-at`. |
| `-O, --order <ORDER>` | One of `asc`, `desc`. Default: `desc`. |
| `-L, --limit <LIMIT>` | Default: `30`. |

Calls [`list_caches`](/reference/api/actions/list-caches/).

### g1t cache usage

What the repository's cache entries hold, against its quota.

```text
g1t cache usage [OPTIONS]
```

Calls [`get_cache_usage`](/reference/api/actions/get-cache-usage/).

### g1t cache delete

Delete cache entries: one by its id, or every entry with a key.

```text
g1t cache delete [OPTIONS] <ENTRY>
```

| Argument or flag | |
| --- | --- |
| `<ENTRY>` | An entry's id (a number, from `g1t cache list`), or a key: every entry with exactly that key. |
| `-g, --ref <REF>` | With a key, only the entries this ref's runs saved. |

Calls [`delete_cache`](/reference/api/actions/delete-cache/), [`delete_caches_by_key`](/reference/api/actions/delete-caches-by-key/).

## g1t deploy

Deployments: list and view, and turn a project's g1t.page deployments on or off.

### g1t deploy list

List deployments, newest first.

```text
g1t deploy list [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-e, --env <ENV>` |  |
| `-s, --state <STATE>` | queued, in_progress, success, failure, error or inactive. |
| `--source <SOURCE>` | api, actions or g1t_page. |
| `-L, --limit <LIMIT>` | Default: `20`. |

Calls [`list_deployments`](/reference/api/deployments/list-deployments/).

### g1t deploy view

Show a deployment and its statuses.

```text
g1t deploy view [OPTIONS] <ID>
```

| Argument or flag | |
| --- | --- |
| `<ID>` |  |
| `-w, --web` |  |

Calls [`get_deployment`](/reference/api/deployments/get-deployment/).

### g1t deploy settings

Show a project's g1t.page deployment settings, or change them with flags.

```text
g1t deploy settings [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-p, --project <PROJECT>` | The project, as SLUG or WORKSPACE/SLUG; the current repository's when left out. |
| `--production <SWITCH>` | Deploy the default branch on every push. One of `on`, `off`. |
| `--previews <SWITCH>` | A preview for every branch with an open pull request. One of `on`, `off`. |
| `--build-as <KIND>` | auto, static, workers or docker. |
| `--build-command <COMMAND>` | Runs instead of the project's own build script; "" for its own. |
| `--output-dir <DIR>` | What a static site serves; "" to find it by itself. |
| `--dockerfile <PATH>` | A container's Dockerfile, inside the project; "" for Dockerfile or Containerfile. |
| `--instance-type <SIZE>` | A container's size: lite, basic, standard-1 to standard-4. |
| `--idle-days <DAYS>` | A preview no one visits this many days comes down: 1 to 90. |
| `--via-workflow <SWITCH>` | Build through the deploy workflow g1t manages for the project. One of `on`, `off`. |

Calls [`get_deployment_settings`](/reference/api/deployments/get-deployment-settings/), [`update_deployment_settings`](/reference/api/deployments/update-deployment-settings/).

### g1t deploy enable

Turn on a project's g1t.page deployments: production builds from the default branch at once.

```text
g1t deploy enable [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-p, --project <PROJECT>` | The project, as SLUG or WORKSPACE/SLUG; the current repository's when left out. |

Calls [`update_deployment_settings`](/reference/api/deployments/update-deployment-settings/).

### g1t deploy disable

Turn off a project's g1t.page deployments: production and every preview come down.

```text
g1t deploy disable [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-p, --project <PROJECT>` | The project, as SLUG or WORKSPACE/SLUG; the current repository's when left out. |

Calls [`update_deployment_settings`](/reference/api/deployments/update-deployment-settings/).

## g1t logs

A project's logs and errors.

```text
g1t logs [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-p, --project <PROJECT>` | The project; the current repository's when left out. |
| `--errors` | Grouped errors instead of log lines. |
| `-q, --query <QUERY>` | Lines holding all of these words, or a "quoted phrase". |
| `-l, --level <LEVEL>` | Levels: trace, debug, info, warn, error, fatal (comma-separated). |
| `-e, --env <ENV>` |  |
| `--service <SERVICE>` |  |
| `-s, --since <SINCE>` | How far back: 15m, 2h, 1d, or a time like 2026-10-12T09:00:00Z. |
| `--state <STATE>` | With --errors: open, resolved or ignored. |
| `-f, --follow` | Keep printing new lines as they come. |
| `-L, --limit <LIMIT>` | Default: `50`. |

Calls [`list_logs`](/reference/api/observability/list-logs/), [`list_errors`](/reference/api/observability/list-errors/), [`list_projects`](/reference/api/projects/list-projects/), [`get_repo`](/reference/api/repositories/get-repo/).

## g1t status

What needs you: your pull requests, reviews asked of you, failing checks, and your sessions and claims here.

```text
g1t status [OPTIONS]
```

Calls [`search`](/reference/api/search/search/), [`list_notifications`](/reference/api/notifications/list-notifications/), [`get_pull_request`](/reference/api/pull-requests/get-pull-request/), [`list_sessions`](/reference/api/sessions/list-sessions/), [`list_claims`](/reference/api/work-items/list-claims/).

## g1t session

Sessions: one run of an agent's harness, recorded as it works.

### g1t session start

Start a session and remember it for this working copy. Prints its id.

```text
g1t session start [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-i, --item <ITEM>` | The work item it works on, by its number in the workspace. |
| `-p, --pull <PULL>` | The pull request it works on. |
| `--harness <HARNESS>` | The harness running it. One of `claude_code`, `codex`, `cursor`, `copilot`, `other`. Default: `other`. |
| `--harness-session-id <ID>` | The harness's own id for the run, which makes starting again return the same session. |
| `-t, --title <TITLE>` |  |
| `-b, --branch <BRANCH>` | The branch it works on; the current one when left out. |
| `--parent <SESSION>` | For a subagent: the session that started it (ses_…). |
| `--agent-type <AGENT_TYPE>` | For a subagent: its kind (Explore, security-reviewer). |
| `--task <TASK>` | For a subagent: the task it was given, in a few words. |
| `--prompt <PROMPT>` | For a subagent: the prompt its parent gave it. |
| `--model <MODEL>` | The model it runs on. |
| `--no-remember` | Do not remember it as this working copy's session (a subagent's, kept by its harness). |

```text
The id is kept in .git/g1t/session (each worktree has its own); G1T_SESSION overrides it.
Starting again with the same --harness-session-id returns the same session.
```

Calls [`start_session`](/reference/api/sessions/start-session/).

### g1t session heartbeat

Say the current session is still working; renews its claims.

```text
g1t session heartbeat [OPTIONS]
```

Calls [`update_session`](/reference/api/sessions/update-session/).

### g1t session log

Record a note, prompt or message in the current session.

```text
g1t session log [OPTIONS] <TEXT>
```

| Argument or flag | |
| --- | --- |
| `<TEXT>` | What to record; - reads it from stdin. |
| `-k, --kind <KIND>` | One of `note`, `prompt`, `message`, `tool_call`, `skill`. Default: `note`. |
| `--tool <TOOL>` | The tool, for a tool_call. |
| `--key <KEY>` | A key that makes recording it again do nothing. |

Calls [`record_session_entries`](/reference/api/sessions/record-session-entries/).

### g1t session attach

Attach the current session to a work item, a pull request or a branch, or give it a title.

```text
g1t session attach [OPTIONS] <--item <ITEM>|--pull <PULL>|--branch <BRANCH>|--head-commit <SHA>|--title <TITLE>>
```

| Argument or flag | |
| --- | --- |
| `-i, --item <ITEM>` | A work item, by its number in the workspace. |
| `-p, --pull <PULL>` |  |
| `-b, --branch <BRANCH>` |  |
| `--head-commit <SHA>` | The commit it pushed last. |
| `-t, --title <TITLE>` | What it is for, in a few words; replaces its title. |

Calls [`update_session`](/reference/api/sessions/update-session/).

### g1t session end

End the current session.

```text
g1t session end [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-r, --reason <REASON>` | Why it ended: done, abandoned, handed_off... |
| `--result <RESULT>` | What it reported when it finished (a subagent's final message); - reads it from stdin. |

Calls [`end_session`](/reference/api/sessions/end-session/).

### g1t session list

List the repository's sessions.

```text
g1t session list [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-s, --state <STATE>` | Only sessions in this state. One of `active`, `idle`, `ended`. |
| `-i, --item <ITEM>` | Only sessions on this work item. |
| `-p, --pull <PULL>` |  |
| `-L, --limit <LIMIT>` | Default: `20`. |
| `--path <PATH>` | Only sessions that touched this file, or any under it when it ends in /. |
| `--subagents` | List subagents too, under the sessions that started them. |
| `--workspace [SLUG]` | Every repository of a workspace you may read, every kind of session: this repository's workspace, or the one named. |
| `--harness <HARNESS>` | With --workspace: only sessions in this harness (claude_code, codex, …). |
| `--person <PERSON>` | With --workspace: only sessions this person runs, by username. |
| `--in <NAME>` | With --workspace: only sessions in this repository of it, by name. |

Calls [`list_sessions`](/reference/api/sessions/list-sessions/), [`list_workspace_sessions`](/reference/api/sessions/list-workspace-sessions/).

### g1t session view

Show a session and what it recorded; the current one when left out.

```text
g1t session view [OPTIONS] [ID]
```

| Argument or flag | |
| --- | --- |
| `[ID]` | The session's id (ses_…); the current one when left out. |

Calls [`get_session`](/reference/api/sessions/get-session/).

### g1t session updates

Read pending coordination updates without acknowledging them.

```text
g1t session updates [OPTIONS] [ID]
```

| Argument or flag | |
| --- | --- |
| `[ID]` | The session's id (ses_…); the current one when left out. |

```text
First says which files this working copy changed (git status, from its root), as `session touch`
would, so another session changing the same files is an overlap.detected for both: heartbeat and
acknowledge do too. G1T_TOUCH=0 turns that off.
```

Calls [`get_session`](/reference/api/sessions/get-session/).

### g1t session acknowledge

Record your decision, then acknowledge exact coordination update IDs.

```text
g1t session acknowledge [OPTIONS] --note <NOTE> <UPDATES>...
```

| Argument or flag | |
| --- | --- |
| `<UPDATES>` | IDs you have considered. Never pass unseen updates. At most 100. |
| `--note <NOTE>` | What changed in your plan, or why no change is needed. |
| `--session <SESSION>` | Use this session instead of G1T_SESSION or the working copy's session. |

Calls [`record_session_entries`](/reference/api/sessions/record-session-entries/).

### g1t session touch

Say what the current session touched: files, commits, branches, pull requests, work items.

```text
g1t session touch [OPTIONS] <--file <FILE>|--commit <COMMIT>|--branch <BRANCH>|--pull <PULL>|--item <ITEM>>
```

| Argument or flag | |
| --- | --- |
| `--file <FILE>` | A file it wrote, from the repository's root. Repeat for more. |
| `--commit <COMMIT>` | A commit it made. |
| `--branch <BRANCH>` | A branch it pushed. |
| `--pull <PULL>` | A pull request it opened. |
| `--item <ITEM>` | A work item it named, by its number in the workspace. |

```text
Each is kept once. A file another active session touched too (a sibling subagent's included)
is an overlap.detected event for both. Pull requests and work items tie the session to them.
```

Calls [`record_session_entries`](/reference/api/sessions/record-session-entries/).

## g1t work

Work items: list, view, new, edit, link, close; claims, hand-offs, dependencies, events.

Flags every `g1t work` command takes:

| Flag | |
| --- | --- |
| `--workspace <SLUG>` | The workspace, by its slug; the current repository's when left out. Also `G1T_WORKSPACE`. |

### g1t work list

List the workspace's work items; with --repo, those linked to that repository.

```text
g1t work list [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-s, --state <STATE>` | One of `open`, `closed`, `all`. Default: `open`. |
| `-l, --label <LABEL>` | Only work items with this label. |
| `-m, --milestone <MILESTONE>` | Only work items in the workspace milestone of this number. |
| `-a, --assignee <ASSIGNEE>` | Only work items assigned to this person (@me for you). |
| `-A, --author <AUTHOR>` | Only work items opened by this person (@me for you). |
| `--role <ROLE>` | With --repo: only those linked to it this way. One of `origin`, `target`, `touched`. |
| `-L, --limit <LIMIT>` | Default: `20`. |

Calls [`list_work_items`](/reference/api/work-items/list-work-items/).

### g1t work view

Show a work item with everything about its work: repositories and what landed, claims, sessions, pull requests, what it waits on, decisions.

```text
g1t work view [OPTIONS] <NUMBER>
```

| Argument or flag | |
| --- | --- |
| `<NUMBER>` | The work item's number. |
| `-c, --comments` | Show its comments too. |
| `-w, --web` | Open it in the browser. |

Calls [`get_work`](/reference/api/work-items/get-work/), [`get_work_item`](/reference/api/work-items/get-work-item/).

### g1t work new

Open a work item, with the current repository as its origin.

```text
g1t work new [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-t, --title <TITLE>` |  |
| `-b, --body <BODY>` | The text. Markdown. |
| `-F, --body-file <FILE>` | Read the text from a file, or - for stdin. |
| `--attach <FILE>` | An image to show after the text (PNG, JPEG, GIF or WebP, at most 10 MB): uploaded, and its Markdown added. Repeat for more. |
| `--target <OWNER/NAME>` | A repository of the workspace where the work is meant to land, OWNER/NAME; repeat for more. |
| `-l, --label <LABEL>` | A label; repeat for more. |
| `-a, --assignee <ASSIGNEE>` | Someone to assign; repeat for more (@me for you). |
| `-m, --milestone <MILESTONE>` | A workspace milestone's number. |
| `-w, --web` | Open the new work item page in the browser instead. |

```text
In a repository, the work item is filed from it (its origin). With --workspace and no
repository of that workspace here, it is filed in the workspace alone. --target names a repository
where the work is meant to land; repeat it for more.
Examples:
  g1t work new --title "Sign-in times out on slow networks" --body "..."
  g1t work new --title "Rename the flag" --target acme/api --target acme/docs
```

Calls [`open_work_item`](/reference/api/work-items/open-work-item/), [`update_work_item`](/reference/api/work-items/update-work-item/), [`upload_attachment`](/reference/api/work-items/upload-attachment/), [`upload_work_item_attachment`](/reference/api/work-items/upload-work-item-attachment/).

### g1t work comment

Comment on a work item.

```text
g1t work comment [OPTIONS] <NUMBER>
```

| Argument or flag | |
| --- | --- |
| `<NUMBER>` | The work item's number. |
| `-b, --body <BODY>` | The text. Markdown. |
| `-F, --body-file <FILE>` | Read the text from a file, or - for stdin. |
| `--attach <FILE>` | An image to show after the text (PNG, JPEG, GIF or WebP, at most 10 MB): uploaded, and its Markdown added. Repeat for more. |

Calls [`add_work_item_comment`](/reference/api/work-items/add-work-item-comment/), [`upload_work_item_attachment`](/reference/api/work-items/upload-work-item-attachment/).

### g1t work edit

Change a work item's title, body, labels, assignees or milestone.

```text
g1t work edit [OPTIONS] <NUMBER>
```

| Argument or flag | |
| --- | --- |
| `<NUMBER>` |  |
| `-t, --title <TITLE>` |  |
| `-b, --body <BODY>` | The text. Markdown. |
| `-F, --body-file <FILE>` | Read the text from a file, or - for stdin. |
| `--add-label <LABEL>` |  |
| `--remove-label <LABEL>` |  |
| `--add-assignee <LOGIN>` |  |
| `--remove-assignee <LOGIN>` |  |
| `-m, --milestone <MILESTONE>` | A workspace milestone's number. |
| `--remove-milestone` | Take it out of its milestone. |

Calls [`update_work_item`](/reference/api/work-items/update-work-item/), [`get_work_item`](/reference/api/work-items/get-work-item/).

### g1t work close

Close a work item.

```text
g1t work close [OPTIONS] <NUMBER>
```

| Argument or flag | |
| --- | --- |
| `<NUMBER>` |  |
| `-r, --reason <REASON>` | One of `completed`, `not_planned`. |
| `-c, --comment <COMMENT>` | Leave a comment as it closes. |
| `--commit <COMMIT>` | The commit on the repository's default branch that did it: its message names the work item after a closing keyword (Fixes #12). Its full hash. It lands there; the work item closes when nothing else is left to land. |

Calls [`close_work_item`](/reference/api/work-items/close-work-item/), [`add_work_item_comment`](/reference/api/work-items/add-work-item-comment/).

### g1t work reopen

Reopen a work item.

```text
g1t work reopen [OPTIONS] <NUMBER>
```

| Argument or flag | |
| --- | --- |
| `<NUMBER>` |  |
| `-c, --comment <COMMENT>` | Leave a comment as it reopens. |

Calls [`reopen_work_item`](/reference/api/work-items/reopen-work-item/), [`add_work_item_comment`](/reference/api/work-items/add-work-item-comment/).

### g1t work link

Link a repository to a work item: where the work must land (target), or touched.

```text
g1t work link [OPTIONS] <NUMBER>
```

| Argument or flag | |
| --- | --- |
| `<NUMBER>` | The work item's number. |
| `--role <ROLE>` | How the repository is linked. One of `target`, `touched`. Default: `target`. |

```text
The repository is the current one, or --repo OWNER/NAME. A work item with targets closes once it
has landed in every one.
Examples:
  g1t work link 12 --repo acme/api
  g1t work link 12 --role touched
```

Calls [`link_work_item`](/reference/api/work-items/link-work-item/).

### g1t work unlink

Unlink a repository from a work item (never its origin).

```text
g1t work unlink [OPTIONS] <NUMBER>
```

| Argument or flag | |
| --- | --- |
| `<NUMBER>` | The work item's number. |

Calls [`unlink_work_item`](/reference/api/work-items/unlink-work-item/).

### g1t work claim

Claim a work item: say you are working on it. Others are told, never stopped.

```text
g1t work claim [OPTIONS] <NUMBER|--title <TITLE>>
```

| Argument or flag | |
| --- | --- |
| `[NUMBER]` | The work item's number. |
| `--title <TITLE>` | Open a new work item with this title and claim it; the current session is attached to it. |
| `--body <BODY>` | The new work item's description. |
| `-n, --note <NOTE>` | What you are doing about it. |
| `--ttl <DURATION>` | How long the claim lasts unless renewed: 30m, 2h (at most 4h). |

```text
With --title instead of a number, a new work item is opened (filed from the current repository)
and claimed in one step, and the current session is attached to it: for work that became a change
others should know about.
Examples:
  g1t work claim 12 --note "Rewriting the retry loop"
  g1t work claim --title "Preview builds time out on large repositories"
```

Calls [`claim_work_item`](/reference/api/work-items/claim-work-item/), [`claim_new_work_item`](/reference/api/work-items/claim-new-work-item/).

### g1t work release

Release your claim on a work item.

```text
g1t work release [OPTIONS] <NUMBER>
```

| Argument or flag | |
| --- | --- |
| `<NUMBER>` |  |
| `-r, --reason <REASON>` | Why: done, blocked, abandoned... |

Calls [`release_claim`](/reference/api/work-items/release-claim/).

### g1t work handoff

Hand a work item over to someone else, or to anyone.

```text
g1t work handoff [OPTIONS] --note <NOTE> <NUMBER>
```

| Argument or flag | |
| --- | --- |
| `<NUMBER>` |  |
| `--to <LOGIN>` | Who takes it over; anyone when left out. |
| `-n, --note <NOTE>` | Where it stands and what is left, for whoever takes it. |

Calls [`hand_off_work_item`](/reference/api/work-items/hand-off-work-item/).

### g1t work status

Active claims and sessions in the repository.

```text
g1t work status [OPTIONS]
```

Calls [`list_claims`](/reference/api/work-items/list-claims/), [`list_sessions`](/reference/api/sessions/list-sessions/).

### g1t work block

Say a work item waits on others: it is blocked by them.

```text
g1t work block [OPTIONS] --by <NUMBER> <NUMBER>
```

| Argument or flag | |
| --- | --- |
| `<NUMBER>` | The work item that waits. |
| `--by <NUMBER>` | The work item it waits on; repeat for more. |

Calls [`get_work_item`](/reference/api/work-items/get-work-item/), [`update_work_item`](/reference/api/work-items/update-work-item/).

### g1t work unblock

Say a work item no longer waits on others.

```text
g1t work unblock [OPTIONS] --by <NUMBER> <NUMBER>
```

| Argument or flag | |
| --- | --- |
| `<NUMBER>` | The work item that waits. |
| `--by <NUMBER>` | The work item it waits on; repeat for more. |

Calls [`get_work_item`](/reference/api/work-items/get-work-item/), [`update_work_item`](/reference/api/work-items/update-work-item/).

### g1t work events

The repository's events; --follow keeps printing them as they happen.

```text
g1t work events [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `-f, --follow` | Keep printing events as they happen, until stopped. |
| `-t, --type <TYPE>` | Only events of this type; repeat for more. |
| `-i, --item <NUMBER>` | Only events about this work item or pull request; repeat for more. |
| `-s, --since <SINCE>` | Only events since then: 15m, 2h, 1d, or a time like 2026-10-12T09:00:00Z. |
| `--after <EVENT_ID>` | Start after this event id, as a follow that stopped would resume. |
| `-L, --limit <LIMIT>` | How many past events to show first. Default: `20`. |

```text
Examples:
  g1t work events --follow --item 12
  g1t work events --follow --type integration.failed --type overlap.detected --json
With --json, each event is one JSON object on a line of its own.
```

Calls [`list_events`](/reference/api/repositories/list-events/).

### g1t work dispatch

Start work on a work item in a session on your own Claude, or print the Claude Code command for it.

```text
g1t work dispatch [OPTIONS] <NUMBER|--title <TITLE>>
```

| Argument or flag | |
| --- | --- |
| `[NUMBER]` | The work item's number. |
| `--title <TITLE>` | Open a new work item with this title and work on it. |
| `--body <BODY>` | The new work item's description. |
| `-i, --instruction <INSTRUCTION>` | What to do beyond what the work item says. |
| `-m, --mode <MODE>` | What kind of work. One of `plan`, `implement`, `review`. |
| `--handoff` | Print the Claude Code command to run yourself; start nothing. |
| `--managed` | Start it on the workspace's Anthropic account, or fail. |

```text
With the workspace's Anthropic AI provider, a Claude Managed Agents session starts on that
account and is recorded on g1t; otherwise (or with --handoff) this prints a `claude` command
to run with g1t's plugin, whose session attaches to the work item as it starts.
Examples:
  g1t work dispatch 12
  g1t work dispatch 12 --mode plan --instruction "Keep the old flag"
  g1t work dispatch --title "Add a healthcheck" --handoff
```

Calls [`start_agent_session`](/reference/api/sessions/start-agent-session/).

## g1t why

Why a file or line is as it is: its commit, pull request, work item, decisions and sessions.

```text
g1t why [OPTIONS] <TARGET>
```

| Argument or flag | |
| --- | --- |
| `<TARGET>` | A file, or a line of it as PATH:LINE. |
| `--ref <REF>` | The branch, tag or commit to read it at; the default branch when left out. |

Calls [`why`](/reference/api/decisions-and-why/why/).

## g1t attach

Upload images, such as a screenshot, to show in a work item, a pull request or a comment; prints their Markdown.

```text
g1t attach [OPTIONS] <FILE>...
```

| Argument or flag | |
| --- | --- |
| `<FILE>` | The files: PNG, JPEG, GIF or WebP, at most 10 MB each. |

```text
Prints each image's Markdown, ![name](url), to paste into a description or a comment; --json prints
{ id, name, url, markdown, content_type, size } (a list for several files). The image is served from
g1t's usercontent address, and anyone given that address can see it, even from a private repository.
--attach FILE on g1t work new, g1t work comment, g1t pr create, g1t pr comment and g1t pr ready
uploads and adds the Markdown for you:
  g1t attach preview.png
  g1t pr comment --body 'The preview, after the fix:' --attach preview.png
```

Calls [`upload_attachment`](/reference/api/work-items/upload-attachment/), [`upload_work_item_attachment`](/reference/api/work-items/upload-work-item-attachment/).

## g1t api

Call any API operation or path, with your token.

```text
g1t api [OPTIONS] [ENDPOINT]
```

| Argument or flag | |
| --- | --- |
| `[ENDPOINT]` | An operation's name, or a path. |
| `--list [QUERY]` | List the operations, or those matching this word. |
| `-X, --method <METHOD>` | The HTTP method: GET unless fields are given, then POST. |
| `-f, --raw-field <KEY=VALUE>` | A string field, key=value. key[]=value adds to a list. |
| `-F, --field <KEY=VALUE>` | A typed field: true, false, null and numbers become JSON; @file reads a file. |
| `-H, --header <KEY:VALUE>` | A request header, key:value. |
| `--input <FILE>` | The request body, from a file or - for stdin. |
| `--paginate` | Follow next pages until there are none. |
| `--slurp` | With --paginate, put every page's items into one array. |
| `-i, --include` | Print the status line and headers too. |
| `--silent` | Print nothing on success. |

```text
ENDPOINT is an operation's name (list_work_items) or a path (/workspaces/{workspace}/work).
{owner}, {name}, {repo} and {workspace} are filled in from the current repository,
and an operation's other path parameters from -f/-F fields of the same name.

Examples:
  g1t api list_work_items -f state=closed
  g1t api /user --jq .username
  g1t api open_work_item -f title='Broken link' -f labels[]=docs
  g1t api list_workflow_runs --paginate --jq '.[].conclusion'
  g1t api --list work
```

## g1t browse

Open the repository, a work item or a pull request in the browser.

```text
g1t browse [OPTIONS] [TARGET]
```

| Argument or flag | |
| --- | --- |
| `[TARGET]` | A work item or pull request number, a file path (path:line), or a commit. |
| `-b, --branch <BRANCH>` | The branch to show files on. |
| `-s, --settings` |  |
| `--work` | The repository's work items: the workspace's Work list, filtered to it. |
| `--pulls` |  |
| `--actions` |  |
| `-n, --no-browser` | Print the address instead of opening it. |

Calls [`resolve_ref`](/reference/api/work-items/resolve-ref/).

## g1t alias

Shortcuts for commands you type often.

### g1t alias set

Make an alias: g1t alias set co 'pr checkout'. Start it with ! to run it through the shell.

```text
g1t alias set [OPTIONS] <NAME> <EXPANSION>
```

| Argument or flag | |
| --- | --- |
| `<NAME>` |  |
| `<EXPANSION>` | What it expands to. $1, $2... take the arguments after it. |

### g1t alias list

List aliases.

```text
g1t alias list [OPTIONS]
```

### g1t alias delete

Delete an alias.

```text
g1t alias delete [OPTIONS] <NAME>
```

| Argument or flag | |
| --- | --- |
| `<NAME>` |  |

## g1t completion

Print a shell completion script.

```text
g1t completion [OPTIONS] <SHELL>
```

| Argument or flag | |
| --- | --- |
| `<SHELL>` | One of `bash`, `elvish`, `fish`, `powershell`, `zsh`. |

## g1t push

Push a local container image to g1t's registry, in chunks.

```text
g1t push [OPTIONS] [IMAGE]
```

| Argument or flag | |
| --- | --- |
| `[IMAGE]` | The local image, [REGISTRY/]NAME[:TAG]. |
| `--as <ADDRESS>` | Where to push, when the image's own name is not an address on g1t.sh. The tag defaults to latest. |
| `--chunk-size <SIZE>` | How much of a layer each request carries: 5MB to 95MB. Default: `90MB`. |
| `--token-stdin` | Read the g1t token from stdin. |
| `--archive <FILE>` | Push a tarball `docker save` wrote, instead of asking docker for the image. |

```text
The token is the first of: --token-stdin, G1T_TOKEN, the account `g1t auth login`
signed in for the registry's host, or what `docker login g1t.sh` stored.
```

## g1t upgrade

Update g1t to the newest release, checked against g1t's release key.

```text
g1t upgrade [OPTIONS]
```

| Argument or flag | |
| --- | --- |
| `--check` | Only say whether a newer release is out. |

```text
Downloads the newest release for this machine from g1t.sh, checks its signature and SHA-256, and puts it
where this g1t is. In a terminal, g1t also says once a day when a newer release is out;
G1T_NO_UPDATE_NOTIFIER=1 turns that off.
```
