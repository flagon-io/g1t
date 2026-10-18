---
title: Guardrails
description: How long a project's checks, merge queue and merge checks may run on g1t's machines, how a sandbox reaches the internet, and how g1t watches for mining.
---

Guardrails decide how long a project's work may run in g1t's sandboxes. A
workspace sets defaults, and each project can override them.

They apply to the runs g1t starts for a project: its checks, its merge
queue and its merge checks. Actions jobs and deploy builds keep their own
time limits. Every sandbox, whatever it runs, is watched for
[mining](#abuse-and-mining).

## Where to set them

- **Workspace defaults**: the workspace's **Settings**, **Guardrails**.
  Owners can change them; members can read them.
- **A project's overrides**: the project's **Settings**, **Guardrails**.
  People with the Admin [role](/guides/access-and-roles/) on
  its repository can see and change them; the page is not shown to anyone
  else.

A time left empty on a project's page follows the workspace's default,
whatever it is now, shown faded. Enter a number to override it for that
project only.

Changes apply to runs that start after you save. A run that is under way
keeps the guardrails it started with. Each change is recorded in the
workspace's [audit log](/guides/audit-log/) as `update_guardrails`, saying
which time caps were set, changed or cleared.

## Time per run

How long each kind of run may take, in minutes. By default:

| Kind of run | Minutes |
| ----------- | ------- |
| Checks      | 45      |
| Merge queue | 45      |
| Merge check | 10      |

At most 240 minutes. A run that reaches its time cap fails, with
"Stopped: it reached its time cap of 45 minutes." The sandbox is stopped
whatever is running in it. Actions jobs keep their own limit: at most 60
minutes on g1t's machines, or less with `timeout-minutes` (see
[Actions](/guides/actions/)). Your plan can cap a run's time lower still.

## Network

Every sandbox reaches the internet, as a CI machine does: package
registries, GitHub, container registries, your cloud's APIs and anything
else a job or build fetches from or sends to. No setting limits the hosts
a sandbox may reach.

A sandbox's requests go straight out. Two kinds of request pass g1t's
runner Worker on the way:

- **A sandbox's report that it stopped itself for mining**, to
  `sandbox.g1t.internal`, which never leaves g1t.
- **Every HTTP and HTTPS request of a workflow job that may be given
  [brokered secrets](#brokered-secrets)**, so they can be filled in. The
  Worker sends each one on, to any host, and tries a download that fails
  midway again. To see a request's host and headers over HTTPS, the
  connection is re-encrypted with a certificate the sandbox is given when
  it starts, which g1t adds to the sandbox's trusted certificates (and
  points Node.js, Python, curl, Cargo and git at). The job's other
  protocols go straight out.

The containers a job starts with [Docker](/guides/actions/#docker), its
services and its build steps share the job's network.

### Brokered secrets

The Worker keeps a workflow's API keys out of its jobs. A
[brokered secret](/guides/secrets-and-variables/#brokered-secrets) names
the hosts it is for, and a job is given a stand-in in place of its value.
As a request to one of those hosts passes the runner Worker, the Worker
puts the real value in place of the stand-in, in the request's headers
(inside `Authorization: Basic` too) and its query string, and swaps it
back should the answer echo it. A request to any other host goes with the
stand-in, and the job's log notes it once. The Worker asks for a job's
stand-ins with that job's own token and keeps them only while the job
runs.

Self-hosted runners' traffic does not pass through g1t, so a runner whose
jobs run on Linux or macOS sends the requests that carry a stand-in to g1t
itself, through a proxy it runs for the job, and g1t fills them in the same
way; see
[on a self-hosted runner](/guides/secrets-and-variables/#on-a-self-hosted-runner).
On Windows, brokered secrets stay stand-ins.

## Abuse and mining

g1t does not run cryptocurrency miners, on any plan. Mining needs hours of
CPU, and g1t's sandboxes watch for it:

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
real job, write to support@g1t.sh and say which run.

Beyond that, what a sandbox may do is bounded by its time cap, your
plan's limits on how much may run and how long, the short-lived
credentials each run is given, and branch protection, which g1t enforces
on every push whatever happened in the sandbox.

## What is not covered

- **Self-hosted runners** run on your machines, and reach whatever those
  machines can. See
  [self-hosted runners](/guides/self-hosted-runners/#security).
