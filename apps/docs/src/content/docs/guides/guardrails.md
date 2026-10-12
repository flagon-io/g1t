---
title: Guardrails
description: Which hosts a project's jobs, checks, merge queue and deploy builds may reach on g1t's machines, how long a run may take, and how each rule is enforced.
---

Guardrails decide what a project's work may do in g1t's sandboxes: which
hosts a sandbox can reach, and how long a run may take. A workspace sets
defaults, and each project can override them.

They apply to every sandbox g1t starts for a project: its Actions jobs,
its checks, its merge queue and its deploy builds. Jobs and deploy builds
get the network list with what builds need added (see [builds](#builds)),
and their own time limit. Merge checks are not covered; see
[what is not covered](#what-is-not-covered). Every sandbox, whatever it
runs, is watched for [mining](#abuse-and-mining).

## Where to set them

- **Workspace defaults**: the workspace's **Settings**, **Guardrails**.
  Owners can change them; members can read them.
- **A project's overrides**: the project's **Settings**, **Guardrails**.
  People with the Admin [role](/guides/access-and-roles/) on
  its repository can see and change them; the page is not shown to anyone
  else.

Every setting on a project's page starts as "As the workspace", which
follows the workspace's default, whatever it is now. Choose a value to
override it for that project only. Allowed domains and workflow-only
domains add up: a project's are added to the workspace's, never
instead of them.

Changes apply to runs that start after you save. A run that is under way
keeps the guardrails it started with.

## Network

With **Only allowed hosts** restricted (the default), a sandbox can reach:

- g1t's own hosts, always: `g1t.sh`, `api.g1t.sh` and `mcp.g1t.sh`, for
  cloning, pushing and reporting;
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
  answers every other with `403`. The refusal names the host three times
  over, since tools differ in what they show of a failed request: in its
  status line (`403 Forbidden by g1t guardrails: example.com is not an
  allowed domain`, which is what a tool that prints only the status shows),
  in an `x-g1t-blocked-host` header beside `x-g1t-guardrails: blocked`, and
  in a plain-text body saying where to allow it: **Allowed domains** for
  every sandbox, or **Workflow-only domains** for the jobs of one workflow
  and environment.
- To see the host of an HTTPS request, the connection is re-encrypted with
  a certificate the sandbox is given when it starts, which g1t adds to the
  sandbox's trusted certificates (and points Node.js, Python, curl, Cargo
  and git at). A program that brings its own fixed list of certificates and
  ignores the system's cannot connect anywhere, allowed or not.

Nothing running in the sandbox, root included, can change this: the rule
is applied where the sandbox's traffic leaves it, not inside it.

Each refused host appears once as a step of the run, such as
`Blocked: example.com (not an allowed domain)`. It is a note, not the
run's state: the run carries on. If a run needs a host, allow it and run
it again.

Tools that send usage reports home are told not to in a sandbox with only
allowed hosts (`DO_NOT_TRACK=1`, and each common tool's own switch, such
as `WRANGLER_SEND_METRICS=false`), so those reports are not refused and
noted on every run.

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
- every package registry above, whatever the project turned on, and
  RubyGems, Packagist, NuGet, Maven Central, Gradle and
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
allowed domains would open them to every sandbox as well. List them under
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

Checks, the merge queue and deploy builds never reach these hosts, whatever the line says. A job that names its environment with an
expression (`environment: ${{ inputs.target }}`) matches only lines with
no environments.

Workflow-only domains are set by the same people as the rest of the page:
owners for the workspace's, Admin for a project's. Each change
is recorded in the workspace's [audit log](/guides/audit-log/) as
`update_guardrails`, saying which domains were added or removed and what
they were limited to.

A deploy that signs in to AWS, Google Cloud or Azure with the job's
[OIDC token](/guides/actions/#oidc-tokens), rather than a key kept in a
secret, needs its cloud's token service listed here, such as
`sts.us-east-1.amazonaws.com | deploy.yml | production`. See
[reaching your cloud](/guides/actions/#reaching-your-cloud) for each
cloud's hosts.

### Brokered secrets

The same interception keeps a workflow's API keys out of its jobs. A
[brokered secret](/guides/secrets-and-variables/#brokered-secrets) names
the hosts it is for, and a job is given a stand-in in place of its value.
As a request to one of those hosts passes the runner Worker, the Worker
puts the real value in place of the stand-in, in the request's headers
(inside `Authorization: Basic` too) and its query string, and swaps it
back should the answer echo it. A request to any other host goes with the
stand-in, and the job's log notes it once. The Worker asks for a job's
stand-ins with that job's own token and keeps them only while the job
runs.

Brokering does not widen the network: a secret's hosts must still be ones
the job may reach. A job whose project's network is open, but which may be
given a brokered secret, still sends its HTTP and HTTPS through the
Worker, which reaches every host for it, and trusts the certificate as a
restricted sandbox does; its other protocols go straight out, as before.
Self-hosted runners' traffic does not pass through g1t, so a runner whose
jobs run on Linux or macOS sends the requests that carry a stand-in to g1t
itself, through a proxy it runs for the job, and g1t fills them in the same
way; see
[on a self-hosted runner](/guides/secrets-and-variables/#on-a-self-hosted-runner).
On Windows, brokered secrets stay stand-ins.

## Time per run

How long each kind of run may take, in minutes. By default:

| Kind of run | Minutes |
| --- | --- |
| Checks | 45 |
| Merge queue | 45 |
| Merge check | 10 |

At most 240 minutes. A run that reaches its time cap fails, with
"Stopped: it reached its time cap of 45 minutes." The sandbox is stopped
whatever is running in it. Actions jobs keep their own limit: at most 60
minutes on g1t's machines, or less with `timeout-minutes` (see
[Actions](/guides/actions/)).

## Abuse and mining

g1t does not run cryptocurrency miners, on any plan. Mining needs a mining
pool and hours of CPU; g1t's sandboxes withhold the first and watch for the
second:

- **No pool to reach.** No mining pool is on any allowed list, so a
  restricted sandbox's miner has nowhere to send its work.
- **Miners by name.** A check, a build command, a workflow step or a container a job starts whose image or
  command names a known miner (`xmrig`, `cpuminer`, `t-rex` and others), a
  pool address (`stratum+tcp://`) or a miner's flags (`--donate-level`,
  `--algo=rx/0`) is refused, whatever the project's rules. A running process whose command line names one stops
  the sandbox at once.
- **The CPU signature.** Every sandbox samples itself every 30 seconds:
  CPU use, file and disk I/O, network bytes, new processes, and whether the
  run did anything (a new check command or workflow step). It is stopped when, for 10 minutes straight, CPU stays at
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
support if this was a real job." A check or merge queue run fails with
it, a workflow job fails with it, and a deployment's status says it. g1t's
staff are told, with the measurements, and look at what ran. If it was a
real job, write to hey@flagon.io and say which run.

## What is not covered

- **Merge checks** only merge two commits; they get no network list.
- **Self-hosted runners** run on your machines, whose network g1t does not
  see: the network list is not enforced there. See
  [self-hosted runners](/guides/self-hosted-runners/#security).
