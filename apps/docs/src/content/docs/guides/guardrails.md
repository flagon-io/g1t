---
title: Guardrails
description: What g1t's agents may reach, run, spend and take in a project's sandboxes, and how each rule is enforced.
---

Guardrails decide what g1t's agents may do in their sandboxes: which hosts
a sandbox can reach, which commands the agent's harness refuses, and how
much one run may cost and how long it may take. A workspace sets defaults,
and each project can override them.

They apply to every sandbox g1t starts for a project's agents (implement,
revise, answer, catch up, review, plan, and replies to mentions). The
sandboxes of its merge queue get the network list and the time cap; they
build the queue's states, not an agent's work, so command rules and the
cost cap do not apply to them. GitHub Actions jobs and deploy
builds get the network list too, with what builds need added (see
[builds](#builds)), and their own time limit. Merge checks are not covered;
see [What is not covered](#what-is-not-covered). Every sandbox, whatever
it runs, is watched for [mining](#abuse-and-mining).

## Where to set them

- **Workspace defaults**: the workspace's **Settings**, **Guardrails**.
  Owners can change them; members can read them.
- **A project's overrides**: the project's **Settings**, **Guardrails**.
  People with the Admin [role](/guides/access-and-roles/) on
  its repository can see and change them; the page is not shown to anyone
  else.

Every setting on a project's page starts as "As the workspace", which
follows the workspace's default, whatever it is now. Choose a value to
override it for that project only. Allowed domains, workflow-only domains
and deny patterns add up: a project's are added to the workspace's, never
instead of them.

Changes apply to runs that start after you save. A run that is under way
keeps the guardrails it started with.

## Network

With **Only allowed hosts** restricted (the default), a sandbox can reach:

- g1t's own hosts, always: `g1t.sh`, `api.g1t.sh`, `models.g1t.sh` and
  `mcp.g1t.sh`, for cloning, pushing, reporting and the model;
- the package registries that are on (all of them by default):

  | Registry | Hosts |
  | --- | --- |
  | npm and Yarn | `registry.npmjs.org`, `registry.yarnpkg.com`, `repo.yarnpkg.com` |
  | PyPI | `pypi.org`, `files.pythonhosted.org` |
  | crates.io and Rust toolchains | `crates.io`, `index.crates.io`, `static.crates.io`, `static.rust-lang.org` |
  | Go module proxy | `proxy.golang.org`, `sum.golang.org` |
  | GitHub downloads | `codeload.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com` |

- the domains you list: `api.stripe.com` allows exactly that host, and
  `*.example.com` allows every subdomain of `example.com` (not
  `example.com` itself; list both if you need both).

`github.com` itself is not on the default list. A project with
dependencies fetched with git from GitHub, rather than as archives, needs it
listed.

### How it is enforced

This is enforced outside the sandbox, by Cloudflare Containers' outbound
interception:

- A restricted sandbox starts with no internet connection at all. Its DNS
  resolves nothing on its own, and no protocol or port other than HTTP (80)
  and HTTPS (443) has any route out: SSH, raw TCP and UDP connections fail.
- Every HTTP and HTTPS request it makes is handed to g1t's runner Worker
  before it leaves. The Worker forwards requests to allowed hosts and
  answers every other with `403` and a line saying the host is not allowed
  and where to allow it.
- To see the host of an HTTPS request, the connection is re-encrypted with
  a certificate the sandbox is given when it starts, which g1t adds to the
  sandbox's trusted certificates (and points Node.js, Python, curl, Cargo
  and git at). A program that brings its own fixed list of certificates and
  ignores the system's cannot connect anywhere, allowed or not.

Nothing running in the sandbox, root included, can change this: the rule
is applied where the sandbox's traffic leaves it, not inside it.

Each refused host appears once as a step of the run, such as
`Blocked: example.com (not an allowed domain)`, on the run's page under
**Agents**. If a run needs a host, allow it and start the work again.

Setting **Only allowed hosts** to Open gives that project's sandboxes the
whole internet, as before guardrails.

### Builds

GitHub Actions jobs and deploy builds reach the project's list, plus what
real builds need, which no setting removes:

- GitHub, where `uses:` actions, `actions/checkout`'s helpers and the
  setup actions' downloads come from: `github.com`, `api.github.com`,
  `codeload.github.com`, `objects.githubusercontent.com`,
  `raw.githubusercontent.com`, `release-assets.githubusercontent.com`,
  `ghcr.io`;
- toolchains: `nodejs.org`, `go.dev`, `dl.google.com`,
  `static.rust-lang.org`, `sh.rustup.rs`;
- every package registry above, whatever the project turned on for its
  agents, and RubyGems, Packagist, NuGet, Maven Central, Gradle and
  Debian's mirrors;
- container registries, for a job's own Docker Engine: Docker Hub
  (`registry-1.docker.io`, `auth.docker.io` and the CDNs its layers come
  from), `mirror.gcr.io`, Quay (`quay.io` and its CDNs), and Docker's
  package repository, `download.docker.com`;
- for deploy builds, Cloudflare's API, which the build uploads its app to.

The repository itself is cloned from g1t, which is always reachable. A
project whose guardrails set **Only allowed hosts** to Open runs its jobs
and builds with an open network too.

The containers a job starts with [Docker](/guides/actions/#docker), its
services and its build steps share the job's network, so this list is
theirs too: an image from another registry, or a build step that
downloads from another host, needs that host allowed, as a step would.

### Workflow-only domains

Some hosts only a workflow should reach: the API a deploy uploads to, a
release server, a package registry you publish to. Listing them under
allowed domains would open them to agents as well. List them under
**Workflow-only domains** instead, one per line:

```
api.cloudflare.com | deploy.yml | production
uploads.example.com | release.yml, nightly.yml
*.internal.example.com
```

| Part | |
| --- | --- |
| The domain | As for allowed domains: `example.com`, or `*.example.com` for its subdomains. |
| Workflows | Workflow files by name, comma-separated, as they are in `.g1t/workflows/`. Left out: any workflow. |
| Environments | The environments a job must name with `environment:`, comma-separated. Left out: any job. |

A domain is reached only by:

- jobs of the workflows and environments its line names;
- in a run that is not of a pull request from a fork, which runs code
  anyone could write.

Agents, checks, the merge queue and deploy builds never reach these
hosts, whatever the line says. A job that names its environment with an
expression (`environment: ${{ inputs.target }}`) matches only lines with
no environments.

Workflow-only domains are set by the same people as the rest of the page:
owners for the workspace's, Admin for a project's. Each change
is recorded in the workspace's [audit log](/guides/audit-log/) as
`update_guardrails`, saying which domains were added or removed and what
they were limited to.

## Commands

The agent's harness checks every tool call the agent makes before it runs.
A refused call does not run; the agent is told it was refused and why, and
the run shows a step such as
`Denied: Ran git push --force origin feature (no force-pushing)`.

Built-in rules, each on by default:

| Rule | What it refuses |
| --- | --- |
| No force-pushing | `git push` with `--force`, `-f`, `--force-with-lease`, `--mirror`, `--delete` or `--prune`, a `+` refspec, or `:branch` to delete one. |
| No rewriting the default branch | Pushing to the default branch, `git branch -f/-d/-D/-m/-M` on it, `git update-ref` of it, and `git filter-branch`, `git filter-repo` and `git replace`. |
| No reading files outside the project | File tools (read, edit, write, search) outside the checked-out project, `/tmp`, and dependency caches (Cargo's registry and git checkouts, Go's module cache, Rust toolchains). Shell commands that touch g1t's own files in the sandbox, or other processes' environments under `/proc`. |
| No printing the environment | `env` and `printenv`, `export -p`, `set` and `declare -p` on their own, `compgen -e`, reading `/proc/*/environ`, and any command that reads a variable whose name contains `TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `CREDENTIAL` or `AUTH`. |
| No sudo | `sudo`, `su`, `doas` and `pkexec`. With this on, the sandbox also gives up root before the agent starts, so nothing the agent runs can become root. |

**Also refuse** adds your own rules, one per line, written as permission
rules:

- `Bash(terraform apply:*)` refuses any shell command that starts with
  those words, wherever it appears in a line (`cd infra && terraform
  apply` too). `Bash(rm -rf *)` uses `*` as a wildcard; `Bash(make deploy)`
  refuses exactly that command.
- `Read(secrets/**)`, `Edit(//etc/**)`: file paths. `//` starts at the
  root, `~/` at the home directory, anything else at the project. `**`
  crosses directories, `*` does not. `Read` covers reading and searching;
  `Edit` covers every tool that writes a file.
- `WebFetch(domain:example.com)` refuses fetching that domain and its
  subdomains.
- A tool's name on its own, such as `WebSearch`, refuses the tool.
- Plain text is the start of a shell command: `kubectl delete` is saved as
  `Bash(kubectl delete:*)`.

### How it is enforced

The rules are written into the harness's managed settings, which no
settings file in the project or the home directory can override, as a hook
the harness runs before every tool call and as its permission rules. With
**No sudo** on, the sandbox then gives up root, so the agent cannot edit
them or the program the hook runs.

This is a guard against an agent's mistakes, not a sandbox against a
determined one. Shell commands are matched as text, and a command can
always be written in a way no rule foresees (built up from variables, or
run from a script the agent wrote). The hard boundaries are elsewhere:

- The network list, enforced outside the sandbox.
- The sandbox's credentials. The agent itself holds none of g1t's: the
  runner clones and pushes with credentials passed per command, and pushes
  only to the run's own fork or branch, never with force. See
  [credentials](/guides/working-with-g1t/#credentials).
- Branch protection on the repository, which g1t enforces when a push
  arrives, whatever the sandbox did.

### Changes from forks

When a run checks out a fork's head (revising, reviewing or answering on
any pull request from a fork, including g1t's own, and replying to a
mention on one), the harness loads nothing from that checkout: no
`CLAUDE.md`, no `.claude/settings.json` or `settings.local.json` (so none
of their hooks or permissions), no `.mcp.json` servers, and no commands or
skills. g1t's guardrails, its tools and the repository's instructions from
its own branches still apply. The run's session says so at the start. This
follows the rule g1t uses for
[repository instructions](/guides/working-with-g1t/#repository-instructions):
they are read from the repository's own branches, never from a fork.

## Caps

**Cost per run**: the most one run may spend on its model, in US dollars.
$2.00 by default, the same as the workspace billing's spend cap per run;
0 means no cap here, though billing's cap still applies; at most $100. The
harness tracks the run's spend as it goes and stops the agent when it
reaches the cap.

**Time per run**: how long each kind of run may take, in minutes. By
default:

| Kind of run | Minutes |
| --- | --- |
| Implement | 90 |
| Revise | 60 |
| Catch up | 45 |
| Review | 30 |
| Plan | 30 |
| Answer | 20 |
| Checks | 45 |
| Merge queue | 45 |
| Merge check | 10 |

At most 240 minutes, but a run's credentials last two hours, so a longer
cap does not give an agent more than that to push.

**The workspace's billing** sets caps too. Every workspace has a spend cap
per run, $2 by default, which owners can set from $0.10 to $100, so a run
stops at $2 unless an owner raises it (see
[caps](/guides/usage-and-billing/#caps)). A new paid workspace's first
month, and the trial, also cap every run's time at 60 minutes (see
[who can run agents](/guides/working-with-g1t/#who-can-run-agents)). A run gets
the lower of its guardrails' cap and its plan's, for time and for cost,
and its page shows the cap it got.

A run that reaches a cap is stopped and marked **Stopped**, with "Stopped
at its cost cap" or "Stopped at its time cap" on its page. A pull request it
was working on is left open for you, as when a person stops a run: raise
the cap if it was too low, then ask for a review, a revision or a catch-up
to start again. A run of checks or the merge queue that reaches its time
cap fails, as a sandbox that stops early always has.

The run's page shows its caps under **Guardrails**: the time so far against
its time cap, live, and its spend against its cost cap. Spend is reported
when the run ends (or stops at its cap), so while it runs the page shows
the cap, not a running total.

### How they are enforced

- The cost cap is enforced by the harness, which counts the run's model
  spend the same way it reports it for billing and stops the agent once
  the spend reaches the cap. The step in flight when it does can take the
  run a little past it.
- The time cap is enforced twice: the harness stops the agent when it
  passes, and the sandbox itself is stopped three minutes after, whatever
  is running in it.

## Abuse and mining

g1t does not run cryptocurrency miners, on any plan. Mining needs a mining
pool and hours of CPU; g1t's sandboxes withhold the first and watch for the
second:

- **No pool to reach.** No mining pool is on any allowed list, so a
  restricted sandbox's miner has nowhere to send its work.
- **Miners by name.** A shell command an agent runs, a check, a build
  command, a workflow step or a container a job starts whose image or
  command names a known miner (`xmrig`, `cpuminer`, `t-rex` and others), a
  pool address (`stratum+tcp://`) or a miner's flags (`--donate-level`,
  `--algo=rx/0`) is refused, whatever the project's rules. A running process whose command line names one stops
  the sandbox at once.
- **The CPU signature.** Every sandbox samples itself every 30 seconds:
  CPU use, file and disk I/O, network bytes, new processes, and whether the
  run did anything (a tool call, an agent step, a new check command or
  workflow step). It is stopped when, for 10 minutes straight, CPU stays at
  or above 90% (one dip allowed) while file and disk I/O average under
  64 KB a second, the network under 16 KB a second, fewer than five new
  processes start, and nothing else happens.

  Compiling and testing are CPU-bound too, but they read sources, write
  objects and start processes (a `cargo build` or `npm test` starts
  hundreds), so they do not match. A compiler can spend minutes in code
  generation with little I/O, so when the busiest process is a known
  compiler or runtime (`rustc`, `cc1`, `clang`, `go`, `javac`, `node` and
  others) the sandbox is not stopped for CPU alone.

A sandbox stopped this way ends with "Stopped: unusual CPU use; contact
support if this was a real job." An agent run shows it under **Agents**
and leaves its pull request for you, a check or merge queue run fails with
it, a workflow job fails with it, and a deployment's status says it. g1t's
staff are told, with the measurements, and look at what ran. If it was a
real job, write to hey@flagon.io and say which run.

## What is not covered

- **GitHub Actions jobs and deploy builds** get the network list and their
  time limit, but no command rules or cost cap: they run commands from the
  repository's workflows and build settings, not an agent.
- **Merge checks** only merge two commits; they are not given guardrails.
- The **commit history** an agent produces is reviewed like any other
  change: guardrails limit what an agent can do while it works, not what
  its change does once it is merged.
