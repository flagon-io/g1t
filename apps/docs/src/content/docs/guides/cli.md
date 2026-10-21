---
title: The g1t CLI
description: Install the g1t command line, sign in, and work with repositories, work items, pull requests, runs, workflows, deployments, secrets and logs from a terminal, a script or an agent.
---

`g1t` is the command line for g1t. It does the work you would otherwise do on
the site: open and review pull requests, wait on checks, read a failing run's
logs, set secrets, read a project's logs, and call any operation of the
[API](/reference/api/). It is one file with nothing to install alongside it,
and it is built to be run by agents as much as by people: every command can
print JSON, nothing waits for input unless a person is at the terminal, and
exit codes say what happened.

```sh
g1t work list --label bug
g1t pr create --fill
g1t pr checks --watch --fail-fast
g1t run logs --failed
```

Every command and flag is listed in the [command reference](/reference/cli/).

## Install

### Homebrew

On macOS or Linux, add the official tap hosted on g1t, then install:

```sh
brew tap flagon-io/tap https://g1t.sh/flagon-io/homebrew-tap.git
brew install flagon-io/tap/g1t
```

The [tap source](https://g1t.sh/flagon-io/homebrew-tap) pins each platform's
binary and SHA-256 checksum to a release. Update Homebrew installations with
`brew update && brew upgrade flagon-io/tap/g1t`.

### Install script

On Linux or macOS:

```sh
curl -fsSL https://g1t.sh/install | sh
```

On Windows, in PowerShell:

```powershell
irm https://g1t.sh/install.ps1 | iex
```

The script picks the build for your system, checks it against the
release's `SHA256SUMS`, and puts `g1t` in `~/.local/bin` (Windows:
`%LOCALAPPDATA%\g1t\bin`, which it adds to your `PATH`). Set
`G1T_INSTALL_DIR` to put it elsewhere, or `G1T_VERSION` to install a
version other than the latest.

### Upgrade

From 0.3.4 on, `g1t upgrade` updates g1t to the newest release:

```sh
g1t upgrade          # download and install the newest release
g1t upgrade --check  # only say whether there is one
```

It reads the newest release's manifest, `latest.json`, and checks its
signature (`latest.json.sig`) against g1t's release key, which is built
into every release. It then downloads the build for your system, checks
its SHA-256 against the manifest, and puts it where the running `g1t` is.
If anything does not check out, nothing changes. Releases come from
`https://g1t.sh/downloads/cli`, or from `G1T_DOWNLOAD_URL` if you set it.

In a terminal, g1t looks for a newer release about once a day, in the
background, and says so after a command when there is one. It never looks
in CI or when its output is not a terminal. Set `G1T_NO_UPDATE_NOTIFIER=1`
to turn it off.

A g1t built from source has no release key and cannot upgrade itself.
Neither can versions before 0.3.4. Update those by running the install
script again.

### Without the script

Each release is a single file per platform, at
`https://g1t.sh/downloads/cli/latest/`:

| Platform             | File                  |
| -------------------- | --------------------- |
| Linux, x64           | `g1t-linux-x64`       |
| Linux, ARM           | `g1t-linux-arm64`     |
| macOS, Apple silicon | `g1t-macos-arm64`     |
| macOS, Intel         | `g1t-macos-x64`       |
| Windows, x64         | `g1t-windows-x64.exe` |

```sh
curl -fsSLo g1t https://g1t.sh/downloads/cli/latest/g1t-linux-x64
chmod +x g1t && mv g1t ~/.local/bin/
```

Check a download against `https://g1t.sh/downloads/cli/latest/SHA256SUMS`.
`latest.json` beside it names the version and each file's SHA-256, and
`latest.json.sig` is its signature. A given version's files are at
`/downloads/cli/<version>/` and never change.

To build it from source, with [Rust](https://www.rust-lang.org/tools/install):

```sh
git clone https://g1t.sh/flagon-io/g1t
cargo install --path g1t/crates/g1t
```

`g1t --version` prints the version you have.

### Behind a TLS proxy

From 0.3.5 on, g1t trusts the certificates in your system's store, as
curl and git do. A sandbox or corporate network that inspects HTTPS (a
Claude Managed Agents sandbox, a guarded runner) adds its proxy's
certificate there, so g1t works through it with nothing to set. Earlier
versions trusted only a list built into the CLI and refused such a proxy.

## Sign in

```sh
g1t auth login
```

`g1t` shows a one-time code and opens your browser at
[g1t.sh/device](https://g1t.sh/device). Sign in there if you are not
already, check the code matches, and approve. The command finishes on its
own once you have. Where there is no browser (a server, a container, a
remote shell), it prints the link instead: open it on any device.

To use an [access token](/guides/authentication/#access-tokens) you already
have, pipe it in:

```sh
g1t auth login --with-token < token.txt
```

The token is kept in your system's credential store: the Keychain on
macOS, Credential Manager on Windows, the Secret Service on Linux. Where
there is none, as on most servers, it goes in the [config
file](#settings-and-environment), readable only by you; `--insecure-storage`
puts it there on purpose.

| Command           | What it does                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `g1t auth status` | Each account you are signed in as, on each host, whether its token still works, and its scopes. Exits `4` when the active account's token does not work. |
| `g1t auth token`  | Prints the token in use, for another program.                                                                                                            |
| `g1t auth logout` | Forgets an account's token.                                                                                                                              |
| `g1t auth switch` | Makes another signed-in account on the same host the active one.                                                                                         |

### G1T_TOKEN

When `G1T_TOKEN` is set, every command uses it instead of a stored token.
This is how to give `g1t` a token in containers, in agents' sandboxes, and
in [workflows](/guides/actions/), where the job's own token is
`secrets.G1T_TOKEN`:

```yaml
- run: g1t pr comment ${{ github.event.pull_request.number }} -b "Preview is up."
  env:
    G1T_TOKEN: ${{ secrets.G1T_TOKEN }}
```

### Self-hosted g1t

`g1t` works with any g1t, not only g1t.sh. Sign in to yours with its
address:

```sh
g1t auth login --hostname git.example.com
```

`g1t` asks it where its API is (its `/.well-known/g1t.json`), and remembers.
After that, commands in a clone of one of its repositories talk to it on
their own. Elsewhere, name it with `--hostname` or `G1T_HOST`; the first host
you sign in to is the default. You can be signed in to several hosts, and
as several accounts on each.

## Use it with git

```sh
g1t auth setup-git
```

This makes `g1t` git's credential helper for each host you are signed in
to, so `git push`, `git fetch` and `git clone` over HTTPS use the same
token, with nothing more to type. It changes your global git config only for
those hosts' addresses (`credential.https://g1t.sh.helper`). `g1t auth login
--git` does both at once. To see the config lines without changing anything,
add `--dry-run`.

[`g1t push`](/guides/containers/#push-large-layers-with-g1t-push), which sends container
images to g1t's registry, uses the same signed-in token.

## Which repository

Commands about a repository work on the one the current directory is a
clone of, found from its git remotes: `upstream` if it is on g1t, then
`origin`, then the first one that is. In a pull request's own [working
copy](/concepts/forks/#working-copies-for-pull-requests), they work on the repository the pull request
is for.

Anywhere else, or to choose another, pass `--repo` (`-R`), or set
`G1T_REPO`:

```sh
g1t pr list -R acme/web
g1t pr view 14 -R git.example.com/acme/web
```

## Everyday work

### Repositories

```sh
g1t repo create my-project --source . --remote g1t   # make it, add it as a remote, push
g1t repo create acme/web --public --clone
g1t repo create acme/site --deploy   # its g1t.page deployments on from the start
g1t repo list acme
g1t repo view acme/web --web
g1t repo clone acme/web
g1t repo fork acme/web --clone
g1t repo sync                 # bring your fork's default branch up to date
```

A repository is private unless `--public` says otherwise, and is made in
your own workspace unless its name says `WORKSPACE/NAME`. `--source`
adds it as a remote of a local repository (`origin` unless `--remote`
names another) and pushes its current branch. `g1t repo fork` forks into
your own workspace, or `--workspace`; see
[forking a repository](/guides/forking-repositories/).

### Work items

```sh
g1t work list                           # open work items, newest first
g1t work list --label bug --assignee @me
g1t work list -R acme/web               # those linked to one repository
g1t work list -R acme/web --role target # those it is a target of
g1t work view 12 --comments
g1t work new --title "Greeting should name the caller" --body "Take a name from the first argument."
g1t work new --title "Rename the flag" --target acme/api --target acme/docs
g1t work comment 12 -b "Fixed in #14."
g1t work edit 12 --add-label p1 --add-assignee @me
g1t work check 12 2                    # tick the second box of its task list
g1t work link 12 --role target -R acme/api
g1t work unlink 12 -R acme/api
g1t work close 12 --reason not_planned
g1t work reopen 12
```

[Work items](/work/work-items/) belong to the workspace, and `g1t work`
works on the current repository's workspace, or the one in `--workspace`
(or `G1T_WORKSPACE`). `-R` filters `g1t work list` to the work items
linked to that repository, and names the repository `g1t work link` and
`g1t work unlink` act on.
`g1t work new` makes the current repository the new work item's origin,
and `--target` names each repository it should land in.
`g1t work view` shows the work item with its whole work context (see
[Claims and context](#claims-and-context)); `--json body` gives its
description alone, for `g1t work edit --body-file`. `g1t work check` and
`g1t pr check` tick a box of a description's [task list](/work/task-lists/),
by its number or by words of its text, and `--uncheck` unticks it; only
that box changes, so a box someone else ticks meanwhile is kept. `@me` is you. At a terminal,
`g1t work new` without `--title` asks for one and opens your editor for
the body.

### The plan

```sh
g1t work plan                           # Now and Next, and how many wait in Triage, Later and Set aside
g1t work plan --all                     # every one of Next, not only its top 10
g1t work plan 191 --next --before 197   # move #191 to Next, just ahead of #197
g1t work plan 203 --now --top           # first in Now
g1t work plan 186 --later --appetite M  # to Later, worth about a week
g1t work plan 195 --urgent              # a fire: first in Now until it closes
g1t work plan 59 --set-aside            # let it go; back with --next or --later
g1t work list --horizon triage          # one horizon, in the plan's order
g1t work next                           # the work item to take next
g1t work next --claim                   # and claim it
g1t work dispatch                       # start a session on what's next
```

[The plan](/work/plan/) says where each open work item stands: Triage,
Now, Next, Later or Set aside, and within a horizon its place is its
priority. `g1t work plan` with a number moves that work item: to a
horizon (`--now`, `--next`, `--later`, `--set-aside`, `--triage`), where
on it (`--before N`, `--after N`, `--top`; with only a horizon it goes
last), and what the plan says of it: `--appetite S|M|L|none`,
`--budget DOLLARS|none`, and `--urgent` or `--not-urgent`.

`g1t work next` prints the work item to take next: the first in Now that
nobody is on, else the top of Next, skipping work items that are blocked,
claimed, or assigned to someone else. `g1t work dispatch` with neither a
number nor `--title` starts a session on that work item.

### Images in descriptions and comments

`g1t attach` uploads images, such as a screenshot of a preview, and prints the
Markdown that shows each, to paste into a description or a comment:

```sh
g1t attach preview.png                  # prints ![preview.png](https://g1tusercontent.com/attachments/…)
g1t attach before.png after.png --json  # id, name, url, markdown, content_type and size of each
g1t pr comment 14 -b "The preview, after the fix:" --attach preview.png
g1t pr ready --summary "Names the caller." --attach preview.png
```

`--attach FILE` (repeat it for more) on `g1t work new`, `g1t work comment`,
`g1t pr create`, `g1t pr comment` and `g1t pr ready` uploads each file and adds
its Markdown after the text. `g1t attach` and the `g1t pr` commands upload to
the repository. `g1t work comment --attach` uploads to the work item, which
keeps the files. `g1t work new --attach` uploads to the repository the work
item is filed from; filed in the workspace alone (with `--workspace` and no
repository of it here), it opens the work item first, then uploads to it and
adds the Markdown to its description. An attachment is a PNG, JPEG, GIF or WebP image of
at most 10 MB, judged by its bytes. It is served from g1t's usercontent address,
never from g1t.sh, and its address is its permission: anyone given it can see
the image, even from a private repository. Never commit an image to the
repository just to link it. Through the API it is
[`upload_attachment`](/reference/api/work-items/upload-attachment/)
(`POST /repos/{owner}/{name}/attachments`) for a repository, and
[`upload_work_item_attachment`](/reference/api/work-items/upload-work-item-attachment/)
(`POST /workspaces/{workspace}/work/{number}/attachments`) for a work item.

### Pull requests

From a branch with your commits on it:

```sh
git switch -c greet-by-name
# ...commit...
g1t pr create --fill --item 12
```

`g1t pr create` pushes the branch, then opens the pull request into the
default branch (`--base` for another). `--fill` takes the title and body from
the branch's commits; `--item` says which work item it is for, by its
number in the workspace; `--draft` opens it as a draft.

To start a pull request for a work item without a branch of your own, as
coding agents usually do, run it with `--item` from the default branch. g1t opens a draft
with a [working copy](/concepts/forks/#working-copies-for-pull-requests) of its own and prints the
copy's git remote. Push your commits there, then mark it ready with a
summary of what changed and why:

```sh
g1t pr create --item 12
git push https://g1t.sh/pulls/pr_….git HEAD:main
g1t pr ready --summary "Reads a name from the first argument."
```

Then, for any pull request:

```sh
g1t pr list
g1t pr view 14                # the current branch's when left out
g1t pr diff 14
g1t pr checkout 14            # check its head out locally
g1t pr checks 14 --watch
g1t pr review 14 --approve -b "Reads well."
g1t pr review 14 --request-changes -b "Trim the name first."
g1t pr merge 14 --delete-branch
```

`g1t pr merge` merges the way the repository is set to, once
[required checks](/guides/checks/) pass and [rules](/guides/rules/) allow;
`--admin` merges past them, with the Admin role.

### Checks and runs

`g1t pr checks` lists a pull request's checks: g1t Actions jobs, check runs
and commit statuses. With `--watch` it waits until they have all finished,
redrawing at a terminal and printing a line per change when piped.
`--fail-fast` stops at the first failure instead of waiting for the rest. It
exits `0` when every check passed, `1` when one failed, and, without
`--watch`, `8` while any are still running.

```sh
g1t run list --branch main
g1t run view                  # the current branch's latest run
g1t run watch run_01kpx7b3c6d9e2f5g8h1j4k7mr
g1t run logs --failed
g1t run rerun --failed
```

A run is named by its id (`run_…`), its number, or its address; left out,
it is the current branch's latest. `g1t run logs --failed` prints only the
steps that failed, each with its last 60 lines (`-n` for more or fewer):
what you need to see why, without the rest of the log. `g1t run watch`
exits `1` if the run fails.

### Workflows

`g1t workflow` works with the workflows in `.g1t/workflows`, as the
repository's **Actions** page does.

```sh
g1t workflow list                      # those turned on; --all for every one
g1t workflow view ci.yml               # its triggers, inputs and latest runs
g1t workflow view release.yml --yaml --ref v1.4.0
g1t workflow run release.yml -f channel=stable
g1t workflow disable Nightly
g1t workflow enable nightly.yml
```

A workflow is named by its file name (`ci.yml`), its id (`wfl_…`) or its
name (`CI`, in any case). When more than one has that name, name it by its
file. Left out at a terminal, g1t asks which; in a script it is an error
that names what to pass.

`g1t workflow run` runs a workflow that has `on: workflow_dispatch`, on the
default branch or the branch or tag `--ref` names, and prints its run's
address once the run is there, so `g1t run watch` can follow it. Give its
inputs with `-f key=value` (or `-F key=@file` to read a value from a file),
or as one JSON object on stdin with `--json`:

```sh
echo '{"channel":"stable","dry_run":true}' | g1t workflow run release.yml --json
```

At a terminal with no inputs given, g1t asks for each, offering its
default. Only the inputs the workflow declares are taken, as on the
[Actions page](/guides/actions/#runs-and-logs). `g1t workflow view --yaml`
prints the workflow's file as it is on the default branch, or on `--ref`.
Turning a workflow off keeps its file: nothing starts it until it is
turned on again, and a workflow the workspace requires stays on.

### Deployments, logs and secrets

```sh
g1t deploy list --env production
g1t deploy view dep_01kq8m3t5v7x9z1b3d5f7h9k2m
g1t deploy enable                       # turn on this project's g1t.page deployments
g1t deploy settings --project acme/web --previews off --build-command "npm run build:site"

g1t logs --since 1h --level error,fatal
g1t logs -q '"payment failed"' --follow
g1t logs --errors --state open

g1t secret list
echo "$NPM_TOKEN" | g1t secret set NPM_TOKEN
g1t secret set STRIPE_KEY --env production < stripe-key.txt
g1t secret set NPM_TOKEN --brokered-host registry.npmjs.org < npm-token.txt
g1t secret delete STRIPE_KEY --env preview
g1t secret list --workspace acme
```

`g1t logs` reads the [observability](/guides/observability/) data of the
current repository's project, or of `--project WORKSPACE/SLUG`. A secret's
value is read from stdin, so it stays out of your shell's history; at a
terminal with nothing piped, `g1t` asks for it without echoing. Values are
never printed. `--brokered-host` makes it a [brokered
secret](/guides/secrets-and-variables/#brokered-secrets).

### What needs you

```sh
g1t status
```

Your open pull requests and their checks, reviews asked of you, what is
assigned to you, and failing checks, across every repository you can see.
Inside a working copy it also lists your active sessions and claims in that
repository.

## Coordinating work

When several people and agents work in one repository, `g1t session` and
`g1t work` say who is on what, so nobody starts work that is already under
way and everyone hears what changes under them. Claims are advisory: a
claim never stops anyone, it tells them.

### Sessions

A session is one run of an agent's harness, such as one Claude Code
session. Starting one remembers it for the working copy, and the commands
after it use it:

```sh
g1t session start --harness claude-code --item 12
g1t session log "Split the parser before touching the lexer."
g1t session attach --pull 14 --head-commit "$(git rev-parse HEAD)"
g1t session heartbeat
g1t session end --reason done
```

| Command                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `g1t session start`                         | Starts a session and prints its id. `--harness` (`claude_code`, `codex`, `cursor`, `copilot` or `other`; `claude-code` works too), `--harness-session-id`, `--item`, `--pull`, `--branch` (the current one by default) and `--title`. Starting again with the same `--harness-session-id` returns the same session. For a subagent, `--parent` (the session that started it), `--agent-type`, `--task`, `--prompt` and `--model`; a subagent's session is not kept as the working copy's (nor is one with `--no-remember`). |
| `g1t session heartbeat`                     | Says the session is still working, and renews its claims. A session with no heartbeat for 15 minutes reads as idle, and after 30 minutes as ended; a heartbeat brings it back.                                                                                                                                                                                                                                                                                                                                              |
| `g1t session log TEXT`                      | Records a note. `--kind` takes `note`, `prompt`, `message`, `tool_call` (or `tool-call`) or `skill` (a skill's name), `--tool` names the tool, and `--key` makes recording the same entry twice do nothing. `-` reads the text from stdin; put `--` before text that starts with a dash.                                                                                                                                                                                                                                    |
| `g1t session attach`                        | Points the session at an `--item`, a `--pull`, a `--branch` or its latest `--head-commit`, or gives it a `--title`: what it is for, which replaces the title it had.                                                                                                                                                                                                                                                                                                                                                        |
| `g1t session touch`                         | Says what the session touched: `--file PATH`, `--commit SHA`, `--branch NAME`, `--pull N` (one it opened), `--item N`, each repeatable. Ties the session to the pull requests and work items they lead to; a file another active session touched too is an `overlap.detected` for both.                                                                                                                                                                                                                                     |
| `g1t session updates [ID]`                  | What other sessions did that concerns this one (claims, overlaps, dependency changes, decisions, merge queue results), oldest first, up to 100. Reading never clears them. It first says which files the working copy changed, so overlapping edits are noticed (`G1T_TOUCH=0` turns that off).                                                                                                                                                                                                                             |
| `g1t session acknowledge ID... --note TEXT` | Records your decision about those updates (what changes in your plan, or why nothing does) and clears exactly the IDs given, for this session only; `--session` names another of yours. Saying the same again does nothing.                                                                                                                                                                                                                                                                                                 |
| `g1t session end`                           | Ends it, with an optional `--reason` and `--result` (what it reported; `-` reads it from stdin), and forgets it. Its subagents still going end with it.                                                                                                                                                                                                                                                                                                                                                                     |
| `g1t session list`                          | The repository's sessions; `--state active`, `--item`, `--pull` (any session tied to it), `--path` (those that touched a file, or a folder ending in `/`), `--subagents` to list subagents under the sessions that started them. `--workspace` (this repository's workspace) or `--workspace SLUG` lists the sessions of every repository of a workspace instead, narrowed by `--harness`, `--person`, `--in NAME` (a repository of it), `--state`, `--item` and `--subagents`; see [the Sessions page](/work/sessions/).   |
| `g1t session view [ID]`                     | A session and what it recorded, its subagents and their results, the work items and pull requests it worked on, and the skills used; the current one without an id.                                                                                                                                                                                                                                                                                                                                                         |

The id is kept in `.git/g1t/session`, in the working copy's own git
directory, so each worktree has its own. `G1T_SESSION` overrides it, for
a harness that runs several sessions in one working copy.

### Claims and context

```sh
g1t work view 12             # everything about #12's work
g1t work claim 12 --note "Taking the parser" --ttl 1h
g1t work claim --title "Preview builds time out" --body "Over 1 GB, the build stops at 10 minutes."
g1t work release 12 --reason done
g1t work handoff 12 --to ana --note "Parser done; lexer tests still fail."
g1t work status              # active claims and sessions here
```

`g1t work view` is the one call to make before starting: the work item and
its definition of done, its repositories with their roles and which have
landed, who has claimed it, its sessions, its pull
requests with their checks, overlaps and place in the merge queue, what it
waits on and what waits on it, its decisions, its last integration failure
and its recent events.

`g1t work claim` says you are working on a work item. It lasts 30 minutes
unless `--ttl` says otherwise (at most `4h`), and a heartbeat of the session
it was made in renews it. It is made in the current session, if there is
one. If others have claimed the work item too, or it waits on work items
that are not done, the answer says so. `g1t work handoff` ends your claim and asks
`--to` someone, or anyone without it, to take the work item over, with a
`--note` saying where it stands. Claims, releases and hand-offs are the
current session's, so two sessions of yours (sibling subagents) each hold
their own.

For work that has no work item yet, `g1t work claim --title "…"` (with
`--body` for its description) opens the work item, with the current
repository as its origin, and claims it in one step, and attaches the
current session to it; it prints the new work item's number. Use it once
the work is a change others should know about, after looking for a work
item that already covers it; questions, exploration and trivial
fixes need none. A number and `--title` together are refused.

### Starting a session on a work item

```sh
g1t work dispatch 12                                   # on the workspace's Anthropic account
g1t work dispatch 12 --mode plan --instruction "Keep the old flag"
g1t work dispatch --title "Add a healthcheck" --handoff  # open the work item; print a claude command
```

`g1t work dispatch` starts work on a work item in a session on your own
Claude: with the workspace's Anthropic [AI provider](/guides/ai/), a Claude Managed Agents
session on that account (it prints the session's page on g1t); without
one, or with `--handoff`, the `claude` command line to run in your working
copy with g1t's [Claude Code plugin](/guides/claude-code-plugin/).
`--managed` fails rather than hand off. `--mode` is `plan`, `implement` or
`review`. See [Start a session on your Anthropic account](/guides/sessions/#start-a-session-on-your-anthropic-account).

`g1t work edit 12 --add-assignee g1t` does the same as **Assign to g1t**
on the site: g1t starts a session on the work item on the workspace's
Anthropic account, as you. See
[Assign g1t](/guides/sessions/#assign-g1t-or-ask-it-in-the-thread).

### Dependencies

```sh
g1t work block 12 --by 9 --by 10    # #12 waits on #9 and #10
g1t work unblock 12 --by 9
```

These change the work item's `blocked_by` through `update_work_item`. A
work item waits only on work items of its workspace, never on itself, and
g1t refuses a cycle.

### Sub-items

```sh
g1t work new --title "Clone cache" --parent 212    # file it under #212
g1t work edit 228 --parent 212                      # make #228 a sub-item of #212
g1t work edit 228 --remove-parent
g1t work list --parent 212                          # #212's sub-items
g1t work close 212 --sub-items move --move-to 219   # close #212, its open sub-items go to #219
```

`g1t work view` says what a work item is a sub-item of and lists its
sub-items with how many are done; `g1t work list` shows `3/7` after a
parent's title and `↑ #212` after a sub-item's. Closing a work item that
has open sub-items asks what to do with them at a terminal; elsewhere say
`--sub-items leave`, `close` or `move`. See [sub-items](/work/sub-items/).

### Following events

`g1t work events` prints the repository's recent events, oldest first.
With `--follow` it keeps printing them as they happen, without a webhook or
a public address, until you stop it with Ctrl-C:

```sh
g1t work events --follow --item 12
g1t work events --follow --type integration.failed --type overlap.detected --json
```

| Flag            |                                                                       |
| --------------- | --------------------------------------------------------------------- |
| `--type`, `-t`  | Only events of this type, such as `work.claimed`; repeat for more.    |
| `--item`, `-i`  | Only events about this work item or pull request; repeat for more.    |
| `--since`, `-s` | Only events since then: `15m`, `2h`, `1d`, or an RFC 3339 time.       |
| `--after`       | Start after this event id, to resume where an earlier follow stopped. |
| `--limit`, `-L` | How many past events to show first; 20 by default.                    |

Each event is one line: its time, type, work item or pull request, a summary
and its id. With `--json`, each is one compact JSON object on a line of its
own, so a program can read them as they come. Following asks
[`list_events`](/reference/api/repositories/list-events/) with `after` and
`wait`, so the server holds each request until something happens; when a
call fails, `g1t` waits (1 second, then longer, up to 30) and resumes from
the last event it printed. A refused token stops it with exit code `4`.

### Why a line is as it is

```sh
g1t why src/parser.rs:120
g1t why src/parser.rs --ref main
```

`g1t why` follows a line to the commit that last changed it, the pull
request that merged that commit, the work item the pull request was for, and
the decisions and sessions recorded on them. A path is read from where you
are in the working copy.

### In an agent's hooks

These commands are made to be run by a harness's hooks in the background:
they never ask anything, they fail at once with exit code `4` when there is
no token, and they give up on a call after 15 seconds. Against a g1t server
older than the CLI, a command it cannot do yet fails saying so.

## Scripting with JSON

Every command takes `--json`. Alone, it prints every field the API returns;
with a comma-separated list, only those (`g1t workflow run` is the one
exception: there, `--json` alone reads the inputs from stdin):

```sh
g1t pr list --json number,title,check_status
```

```json
[{ "check_status": "passed", "number": 14, "title": "Greeting should name the caller" }]
```

The fields are the API's own, named as in the [API reference](/reference/api/)
and always `snake_case`. A field that does not exist is an error that lists
the ones that do. Piped, JSON is one compact line with its keys in a fixed
order, so the same input gives the same output; at a terminal it is
indented.

`--jq` runs a [jq](https://jqlang.org/manual/) expression over the JSON,
with nothing else to install. Strings come out bare, everything else as
JSON:

```sh
g1t pr list --jq '.[] | select(.check_status == "failed") | .number'
g1t run list --jq '.[] | [.id, .conclusion] | @tsv'
```

Without `--json`, output piped to another program is one record per line,
fields separated by tabs, with no header and no color, ready for `cut`,
`awk` or `while read`. Lists show 20 entries unless `--limit` (`-L`) says
otherwise.

### Exit codes

| Code | Meaning                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------- |
| `0`  | It worked.                                                                                           |
| `1`  | It failed: the API refused it, the network failed, checks or a run failed.                           |
| `2`  | The command was used wrongly: an unknown flag, a missing argument, a JSON field that does not exist. |
| `4`  | Signing in is needed, or the token was refused.                                                      |
| `8`  | Checks are still running (`g1t pr checks` without `--watch`).                                        |

An error is one line on stderr, starting `g1t:`. When a token lacks a
[scope](/guides/authentication/#scopes) the call needs, the line names it.

### No questions when piped

`g1t` asks for a missing title, opens an editor for a body, or offers a
choice only when stdin and stderr are both a terminal. Anywhere else, and
whenever `G1T_PROMPT_DISABLED` is set, a command missing something fails at
once with exit code `2` and names the flag that supplies it.

## Call any operation

`g1t api` calls any operation of the [API](/reference/api/) by its name,
with your token, and fills the repository in from where you are:

```sh
g1t api list_work_items -f state=closed --jq '.[].title'
g1t api create_label -f name=p1 -f color=d73a4a
g1t api get_workflow_run -f id=run_01kpx7b3c6d9e2f5g8h1j4k7mr
g1t api --list label          # the operations about labels
```

A path works too, with `{owner}`, `{name}` and `{workspace}` filled in:

```sh
g1t api /workspaces/{workspace}/labels
g1t api user --jq .username
```

`-f key=value` sends a string, `-F key=value` sends `true`, `false`, `null`
and numbers as JSON and `@file` as a file's contents, and `key[]=value` adds
to a list. Fields go in the query of a `GET` and in the JSON body otherwise.
`-X` sets the method, `-H` adds a header, and `--input file` sends a file as
the body. `--paginate` follows each next page, and with `--slurp` puts every
page's items in one array. A request the API refuses prints its error body
and exits `1`.

In Git Bash on Windows, an argument starting with `/` is turned into a
Windows path before `g1t` sees it: leave the leading slash off
(`g1t api repos/{owner}/{name}`), or set `MSYS_NO_PATHCONV=1`.

## From agents and harnesses

An agent with a shell, such as Claude Code, Codex or Cursor, can use `g1t`
the way you do. A command and its JSON cost an agent less of its context
than a set of tool definitions, and the agent finds what it needs with
`--help`. For clients without a shell, use the [MCP server](/reference/mcp/).

1. Install `g1t` where the agent runs, as [above](#install).
2. Give it a token. Either sign in once with `g1t auth login` as the user
   the agent runs as, or set `G1T_TOKEN` in its environment. Make a token
   with only the [scopes](/guides/authentication/#scopes) it needs.
3. Tell it `g1t` is there. A few lines in the project's `CLAUDE.md` or
   `AGENTS.md` are enough:

```md
This repository is on g1t. Use the `g1t` CLI for work items, pull requests,
checks and runs; add `--json` to read results, and see `g1t <command> --help`.

- Open a pull request: `g1t pr create --fill --item <n>`
- Wait for checks: `g1t pr checks --watch --fail-fast` (exit 0 passed, 1 failed)
- See why a run failed: `g1t run logs --failed`
- Run a workflow by hand: `g1t workflow run <file> -f key=value`
- Anything else: `g1t api --list <word>`, then `g1t api <operation>`
```

`g1t` never waits for input in an agent's shell, since its stdin is not a
terminal. Its JSON is compact and in a stable order, its lists are short
by default, and `g1t pr checks --watch --fail-fast` and `g1t run logs
--failed` give an agent the one thing it is waiting for, and no more.

## Aliases and completion

An alias is a shortcut for a command you type often. `$1`, `$2`… take the
arguments after it, and the rest go on the end:

```sh
g1t alias set bugs 'work list --label bug'
g1t alias set co 'pr checkout'
g1t alias set mine '!g1t pr list --author @me --json number,title'
g1t bugs --limit 5
```

An alias starting with `!` runs in `sh`. `g1t alias list` lists them, and
`g1t alias delete` removes one.

`g1t completion <shell>` prints a completion script for `bash`, `zsh`,
`fish`, `powershell` or `elvish`:

```sh
g1t completion bash > ~/.local/share/bash-completion/completions/g1t
g1t completion zsh > "${fpath[1]}/_g1t"
g1t completion fish > ~/.config/fish/completions/g1t.fish
g1t completion powershell >> $PROFILE
```

## Settings and environment

`g1t` keeps the hosts you are signed in to, their accounts and your aliases
in `config.json`, in `~/.config/g1t` (`%APPDATA%\g1t` on Windows;
`$XDG_CONFIG_HOME/g1t` when that is set).

| Variable                         |                                                            |
| -------------------------------- | ---------------------------------------------------------- |
| `G1T_TOKEN`                      | A token to use instead of the stored one.                  |
| `G1T_HOST`                       | The host to use when no repository names one.              |
| `G1T_REPO`                       | The repository, as `[HOST/]OWNER/NAME`.                    |
| `G1T_WORKSPACE`                  | The workspace `g1t work` works on, as `--workspace` says.  |
| `G1T_CONFIG_DIR`                 | Where to keep `config.json`.                               |
| `G1T_KEYRING`                    | `off` keeps tokens out of the system's credential store.   |
| `G1T_PROMPT_DISABLED`            | Never ask anything.                                        |
| `G1T_EDITOR`, `VISUAL`, `EDITOR` | The editor for bodies and summaries.                       |
| `G1T_BROWSER`, `BROWSER`         | The browser `--web` and `g1t browse` open.                 |
| `NO_COLOR`                       | Plain output at a terminal too.                            |
| `G1T_DEBUG`                      | Print each request's method, address and status on stderr. |
