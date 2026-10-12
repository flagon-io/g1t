---
title: The g1t CLI
description: Install the g1t command line, sign in, and work with repositories, issues, pull requests, runs, deployments, secrets and logs from a terminal, a script or an agent.
---

`g1t` is the command line for g1t. It does the work you would otherwise do on
the site: open and review pull requests, wait on checks, read a failing run's
logs, set secrets, read a project's logs, and call any operation of the
[API](/reference/api/). It is one file with nothing to install alongside it,
and it is built to be run by agents as much as by people: every command can
print JSON, nothing waits for input unless a person is at the terminal, and
exit codes say what happened.

```sh
g1t issue list --label bug
g1t pr create --fill
g1t pr checks --watch --fail-fast
g1t run logs --failed
```

Every command and flag is listed in the [command reference](/reference/cli/).

## Install

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
version other than the latest. Run it again to update.

### Without the script

Each release is a single file per platform, at
`https://g1t.sh/downloads/cli/latest/`:

| Platform | File |
| --- | --- |
| Linux, x64 | `g1t-linux-x64` |
| Linux, ARM | `g1t-linux-arm64` |
| macOS, Apple silicon | `g1t-macos-arm64` |
| macOS, Intel | `g1t-macos-x64` |
| Windows, x64 | `g1t-windows-x64.exe` |

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

| Command | What it does |
| --- | --- |
| `g1t auth status` | Each account you are signed in as, on each host, whether its token still works, and its scopes. Exits `4` when the active account's token does not work. |
| `g1t auth token` | Prints the token in use, for another program. |
| `g1t auth logout` | Forgets an account's token. |
| `g1t auth switch` | Makes another signed-in account on the same host the active one. |

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
copy](/guides/pull-requests/), they work on the repository the pull request
is for.

Anywhere else, or to choose another, pass `--repo` (`-R`), or set
`G1T_REPO`:

```sh
g1t issue list -R acme/web
g1t pr view 14 -R git.example.com/acme/web
```

## Everyday work

### Issues

```sh
g1t issue list                          # open issues, newest first
g1t issue list --label bug --assignee @me
g1t issue view 12 --comments
g1t issue create -t "Greeting should name the caller" -b "Take a name from the first argument."
g1t issue comment 12 -b "Fixed in #14."
g1t issue edit 12 --add-label p1 --add-assignee @me
g1t issue close 12 --reason not_planned
```

`@me` is you. At a terminal, `g1t issue create` without `--title` asks for
one and opens your editor for the body.

### Pull requests

From a branch with your commits on it:

```sh
git switch -c greet-by-name
# ...commit...
g1t pr create --fill --issue 12
```

`g1t pr create` pushes the branch, then opens the pull request into the
default branch (`--base` for another). `--fill` takes the title and body from
the branch's commits; `--issue` says which issue it is for; `--draft` opens
it as a draft.

To start a pull request for an issue without a branch of your own, as g1t's
agents do, run it with `--issue` from the default branch. g1t opens a draft
with a [working copy](/guides/pull-requests/) of its own and prints the
copy's git remote. Push your commits there, then mark it ready with a
summary of what changed and why:

```sh
g1t pr create --issue 12
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

### Deployments, logs and secrets

```sh
g1t deploy list --env production
g1t deploy view dep_01kq8m3t5v7x9z1b3d5f7h9k2m

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

## Scripting with JSON

Every command takes `--json`. Alone, it prints every field the API returns;
with a comma-separated list, only those:

```sh
g1t pr list --json number,title,check_status
```

```json
[{"check_status":"passed","number":14,"title":"Greeting should name the caller"}]
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

| Code | Meaning |
| --- | --- |
| `0` | It worked. |
| `1` | It failed: the API refused it, the network failed, checks or a run failed. |
| `2` | The command was used wrongly: an unknown flag, a missing argument, a JSON field that does not exist. |
| `4` | Signing in is needed, or the token was refused. |
| `8` | Checks are still running (`g1t pr checks` without `--watch`). |

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
g1t api list_issues -f state=closed --jq '.[].title'
g1t api create_label -f name=p1 -f color=d73a4a
g1t api get_workflow_run -f id=run_01kpx7b3c6d9e2f5g8h1j4k7mr
g1t api --list label          # the operations about labels
```

A path works too, with `{owner}`, `{name}` and `{workspace}` filled in:

```sh
g1t api /repos/{owner}/{name}/labels
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
This repository is on g1t. Use the `g1t` CLI for issues, pull requests,
checks and runs; add `--json` to read results, and see `g1t <command> --help`.

- Open a pull request: `g1t pr create --fill --issue <n>`
- Wait for checks: `g1t pr checks --watch --fail-fast` (exit 0 passed, 1 failed)
- See why a run failed: `g1t run logs --failed`
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
g1t alias set bugs 'issue list --label bug'
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

| Variable | |
| --- | --- |
| `G1T_TOKEN` | A token to use instead of the stored one. |
| `G1T_HOST` | The host to use when no repository names one. |
| `G1T_REPO` | The repository, as `[HOST/]OWNER/NAME`. |
| `G1T_CONFIG_DIR` | Where to keep `config.json`. |
| `G1T_KEYRING` | `off` keeps tokens out of the system's credential store. |
| `G1T_PROMPT_DISABLED` | Never ask anything. |
| `G1T_EDITOR`, `VISUAL`, `EDITOR` | The editor for bodies and summaries. |
| `G1T_BROWSER`, `BROWSER` | The browser `--web` and `g1t browse` open. |
| `NO_COLOR` | Plain output at a terminal too. |
| `G1T_DEBUG` | Print each request's method, address and status on stderr. |
