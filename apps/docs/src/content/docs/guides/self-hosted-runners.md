---
title: Self-hosted runners
description: Run your workflow jobs, and if you choose your agents' work, on your own machines. Their time costs nothing.
---

A self-hosted runner is a machine of yours that runs your workflow jobs
instead of g1t's sandboxes. It can be a server, a Mac in a cupboard, a
Windows box with a GPU, or a pod in your cluster. On Linux you run
`g1t-runner` as a container under [Sysbox](#run-it-as-a-container), so
neither the runner nor its jobs can reach the machine; it registers once
and picks up jobs that ask for it with `runs-on: self-hosted`.

- **Time on your runners is $0**, on every plan, including the free one.
  It shows on [usage](/guides/usage-and-billing/) as self-hosted minutes.
- **It only connects out.** The runner polls `api.g1t.sh` over HTTPS for
  work. Nothing needs to reach the machine: no open port, no tunnel.
- **Each job in a fresh sandbox.** Every job gets a container of its own,
  made for it and removed after it, inside the runner's own container.
  See [isolation](#isolation).
- **Any OS.** Linux, macOS and Windows, on x64 and arm64. On macOS and
  Windows, sandboxed jobs are [not built yet](#windows-and-macos).

| Where | Page | Who manages it |
| --- | --- | --- |
| A workspace | **Workspace → Runners** in the rail, `g1t.sh/<workspace>/-/runners` | Owners only. |
| A project | **Settings → Runners**, `g1t.sh/<workspace>/<project>/settings/runners` | People with the Admin [role](/guides/access-and-roles/) on its repository |

A workspace's runners serve the repositories their [group](#groups) allows.
A project's own runners serve only that project.

## Run it as a container

On a Linux machine, run the runner's image with the Sysbox runtime. The
runner starts a Docker Engine of its own inside its container and runs
each job in a container on that engine, so jobs are containers inside the
runner's container. Sysbox gives the runner's container a user namespace
of its own, so its root is an unprivileged user on the machine, and lets
it run Docker without `--privileged` and without the machine's Docker
socket.

1. Install [Sysbox](https://github.com/nestybox/sysbox) on the machine,
   following its install guide. It needs Linux; Docker Desktop on macOS
   and Windows cannot use it.
2. Make a registration token: open **Runners** and click **New runner**.
3. Run the runner:

   ```sh
   docker run -d --name g1t-runner --restart unless-stopped \
     --runtime=sysbox-runc \
     -v g1t-runner:/data \
     -e G1T_RUNNER_URL=https://g1t.sh \
     -e G1T_RUNNER_TOKEN=g1trt_… \
     g1t.sh/flagon-io/g1t-runner
   ```

The image runs `register-and-run`, which registers once and then runs.
Its configuration and credential are kept on the `g1t-runner` volume, so
the container can be restarted and replaced without registering again.
Every [register option](#register-options) can come from
`G1T_RUNNER_<OPTION>` in the environment, such as `G1T_RUNNER_LABELS=gpu`
or `G1T_RUNNER_MEMORY=8g`, so a secret can hold the token.

Its log says which isolation it has:

```text
… Isolation: nested-container: each job runs in a fresh container on this runner's own Docker Engine, inside the runner's sandboxed container; neither reaches the machine.
```

Do not give the container the machine's Docker socket
(`-v /var/run/docker.sock:/var/run/docker.sock`) or `--privileged`. The
runner looks for both when it starts, and refuses to start if it finds
them:

| It finds | What it says |
| --- | --- |
| An engine's socket mounted in from the machine (`docker.sock`, `containerd.sock`, `podman.sock`, under any name) | *… is a container engine's socket mounted in from outside this container* |
| An engine's socket it did not make, such as from a mounted `/var/run` | *… is a container engine's socket that this runner did not make* |
| `DOCKER_HOST` set | *DOCKER_HOST is set …* |
| Root in the container is root on the machine (no Sysbox, or `--privileged`) | *root in this container is root on the machine* |

To start anyway, with jobs able to reach the machine, set
`G1T_RUNNER_UNSAFE_ALLOW_HOST_ACCESS=1`. The runner then logs each
problem with `UNSAFE:` in front, and registers as `container` rather than
`nested-container`.

The engine's images and build cache are kept in the container, so they
last until the container is removed. Sysbox keeps them on the machine's
disk for that container alone; to keep them when you replace the
container, add `-v g1t-runner-docker:/var/lib/docker`, a volume for one
runner container at a time.

## Isolation

How well a runner keeps work from its machine. A runner tells g1t its
level when it registers.

| Isolation | How you get it | What a job can reach |
| --- | --- | --- |
| `nested-container` | The runner's image under Sysbox, as above. | Its own container, and its own Docker Engine if it uses Docker. Not the machine, and not other jobs. |
| `container` | `g1t-runner` installed on the machine with Docker, or the image given the machine's Docker socket with the override. | Its own container. The runner itself drives the machine's Docker, which can do anything on the machine, so a job that escapes its container, or anything that takes over the runner, controls the machine. |
| `host` | `--no-docker`. Deprecated. | Everything the runner's user can: the machine, its files, and what earlier jobs left. |

### What a job's container gets

With `nested-container` and `container` isolation, each job runs in a
container made for it and removed after it:

| | |
| --- | --- |
| Image | The job's `container:`, else the runner's `--image`, else `node:24-bookworm`. |
| Mounts | The harness (`g1t-runner`), read-only, and a volume of its own at `/home/runner`, removed after the job. Nothing else of the runner's or the machine's. |
| Network | A Docker network of its own, removed after the job. Never the machine's network. |
| Capabilities | Every one dropped but `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETUID`, `SETGID`, `KILL` and `NET_BIND_SERVICE`, which installing packages and running test servers need. Raw sockets (`ping`) are among those dropped. |
| Privileges | `no-new-privileges`: a setuid program such as `sudo` gains nothing. Run steps as the image's root user rather than with `sudo`. Agent work keeps `sudo`, which its image uses once to put its guardrails out of the agent's reach. |
| Limits | `--memory` (three quarters of the runner's memory unless you set it, with no swap beyond it), `--cpus` (every CPU unless you set it) and `--pids-limit` (4096 unless you set it). |
| Credentials | Only the job's own short-lived token, passed by name. Never the runner's credential. |

### Docker in jobs

With `nested-container` isolation, a job that uses Docker (its
`services:`, a Docker action, a `docker://` step, or `docker` in a step)
gets a Docker Engine of its own. It starts the first time the job uses
Docker, from `docker:28-dind`, beside the job's container and on the job's
network, so a service's published ports are on the job's `localhost`. It
is removed, with its images and containers, when the job ends. A job that
does not use Docker never starts one.

The job's engine is privileged inside the runner's container. Sysbox keeps
it off the machine, but a job that uses Docker can reach the runner's own
container, the runner's credential included. For code you do not trust,
use [ephemeral runners](#autoscaling), so each job has a runner container
of its own, or register with `--no-job-docker`, which gives jobs no Docker.

With `container` isolation, jobs have no Docker of their own, since it
would be the machine's: their `services:` are not started, and the log
says so.

### Host mode is deprecated

`--no-docker` still works, and runs each job directly on the machine in a
folder of its own. It will be removed. Until then:

- The runner's log says so when it starts: *Deprecated: this runner runs
  jobs directly on this machine (--no-docker), unsandboxed.*
- Every job's log starts with a warning: *This job ran on the host,
  unsandboxed …*
- It refuses a public repository's work, which anyone can propose code
  to: *acme/web is public, and this self-hosted runner runs jobs directly
  on its machine (--no-docker), unsandboxed, so it does not take a public
  repository's work.* The job fails with that message.

Move a Linux runner to [the container](#run-it-as-a-container). A macOS
or Windows runner stays in host mode until sandboxes for them are built.

### Windows and macOS

Sandboxed jobs on Windows and macOS are not built yet; jobs native to
those systems run in host mode. What is planned:

| | How each job will run |
| --- | --- |
| Windows | A Windows container with Hyper-V isolation: a small virtual machine with its own kernel, made from a signed image for the job and destroyed after it. |
| macOS | An ephemeral macOS virtual machine, using Apple's Virtualization framework, cloned from a signed image for the job and deleted after it. Apple's licence allows two macOS virtual machines per Mac at once, so a Mac will run at most two jobs at a time. |

On both, the only part on the machine itself will be a small launcher that
makes and destroys those sandboxes from signed images; the runner and the
job run inside them.

On a Mac or Windows machine with Docker Desktop, a runner installed there
without `--no-docker` already runs jobs in Linux containers, with
`container` isolation.

## The Runners page

A workspace's **Runners** page shows g1t cloud and your own runners side
by side, with what each is running now and this month's time on each.

| Part | What it shows |
| --- | --- |
| **g1t cloud** | How many agent runs and workflow jobs are running in g1t's sandboxes now, this month's sandbox time and what it came to at price, the price per minute from g1t's [price book](/guides/usage-and-billing/), and how many agent runs your plan allows at once. |
| **Your runners** | How many are online, busy, idle and offline, this month's self-hosted time (always $0), how many jobs and agent runs are waiting for one of them, and whether they take agent work. |
| **On g1t cloud now** | Each running agent run and workflow job, linked to its run, with its kind, project and when it started. Work handed to one of your runners is listed under that runner instead. |
| **Machine time** | This month's time on g1t cloud against your runners', from your [usage](/guides/usage-and-billing/). |
| **Your runners** list | Each runner's status, labels, OS, architecture, `g1t-runner` version and when it was last heard from, and what it is running, linked to the workflow run or the agent run. |
| **Where work runs** | What decides where each kind of work runs, and the [agent setting](#agents-on-your-runners). |

A runner is **Idle** when it is online with nothing to do, **Busy** while it
runs a job or an agent run, and **Offline** when it has not polled for 90
seconds. When a service does not answer, only its part of the page says so.

Sessions that persist are here for workspace agents: each has
[a computer of its own](/guides/agents/#its-computer) on g1t cloud, whose
home stays between sessions and which sleeps when idle; the page says so
under **Agents' computers and more**. Pinning an agent's computer to one of
your own runners, a runner in the desktop app, and an official agent image
are coming, and the page labels them so.

## Add a runner

On Linux, [run it as a container](#run-it-as-a-container). To install
`g1t-runner` on a machine instead, as on macOS and Windows:

1. Open **Runners** (a project's: **Settings → Runners**) and click **New runner**. g1t makes a
   registration token and shows the commands for Linux, macOS, Windows and
   Docker with it filled in. The token lasts an hour, can register any
   number of runners until then, and is shown once.
2. On the machine, download `g1t-runner` and register it:

   ```sh
   # Linux (x64; use g1t-runner-linux-arm64 on arm64)
   curl -fsSLo g1t-runner https://g1t.sh/downloads/runner/latest/g1t-runner-linux-x64
   chmod +x g1t-runner
   ./g1t-runner register --url https://g1t.sh --token g1trt_…
   ```

   ```sh
   # macOS (Apple silicon; use g1t-runner-macos-x64 on Intel)
   curl -fsSLo g1t-runner https://g1t.sh/downloads/runner/latest/g1t-runner-macos-arm64
   chmod +x g1t-runner
   ./g1t-runner register --url https://g1t.sh --token g1trt_…
   ```

   ```powershell
   # Windows (PowerShell)
   Invoke-WebRequest https://g1t.sh/downloads/runner/latest/g1t-runner-windows-x64.exe -OutFile g1t-runner.exe
   .\g1t-runner.exe register --url https://g1t.sh --token g1trt_…
   ```

3. Start it: `./g1t-runner run` keeps it running in the terminal, or
   install it as a service that starts with the machine:

   | OS | Command | What it makes |
   | --- | --- | --- |
   | Linux | `sudo ./g1t-runner service install` | A systemd unit, `g1t-runner-<name>`; its log is `journalctl -u g1t-runner-<name>` |
   | macOS | `./g1t-runner service install` | A launch agent, `sh.g1t.g1t-runner-<name>`; its log is `~/.g1t-runner/runner.log` |
   | Windows | `.\g1t-runner.exe service install`, from an Administrator prompt | A Windows service, `g1t-runner-<name>`, that restarts if it stops |

   `service start`, `stop`, `status` and `uninstall` do what they say.

The runner shows up in the list within a few seconds, with a green dot.

Installed this way, it has `container` isolation with Docker, or `host`
isolation with `--no-docker`. See [isolation](#isolation).

### Register options

| Option | |
| --- | --- |
| `--url` | The g1t you register with: `https://g1t.sh`. |
| `--token` | The registration token. |
| `--name` | What to call it. The machine's name if left out. Names are unique within a workspace (or project). |
| `--labels` | Extra labels, comma-separated: `gpu,cuda-12`. See [labels](#labels). |
| `--group` | A workspace runner's [group](#groups). The default group, or the one the token was made for, if left out. |
| `--ephemeral` | Take one job, then remove itself. For [autoscaling](#autoscaling). |
| `--no-docker` | Deprecated. Run jobs directly on the machine instead of in containers ([host mode](#host-mode-is-deprecated)). |
| `--image` | The image workflow jobs run in when they name no `container:`. `node:24-bookworm` if left out. |
| `--agent-image` | The image [agent work](#agents-on-your-runners) runs in. |
| `--memory` | Each job container's memory, such as `8g`. Three quarters of the runner's memory if left out. |
| `--cpus` | Each job container's CPUs, such as `4` or `1.5`. Every CPU if left out. |
| `--pids-limit` | The most processes in a job container. 4096 if left out. |
| `--no-job-docker` | Give jobs no [Docker of their own](#docker-in-jobs). |
| `--job-docker-image` | The image a job's own Docker Engine runs. `docker:28-dind` if left out. |
| `--work-dir` | Where jobs run with `--no-docker` keep their files. `~/.g1t-runner/work` if left out. |
| `--dir` | Where the runner keeps its configuration and credential. `~/.g1t-runner`, or `G1T_RUNNER_DIR`, if left out. Every command takes it. |
| `--replace` | Take the place of a runner with the same name. |
| `--no-auto-update` | Never update itself. |

To run several runners on one machine, give each its own `--dir` and
`--name`.

## Use it in a workflow

A job runs on a self-hosted runner when its `runs-on` names `self-hosted`:

```yaml
jobs:
  test:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v5
      - run: make test

  gpu:
    runs-on: [self-hosted, linux, gpu]
    steps:
      - run: nvidia-smi

  windows:
    runs-on: [self-hosted, windows]
    steps:
      - run: Get-ComputerInfo | Select-Object OsName
```

Until a runner with every label the job names takes it, the job waits, and
its page says what for: *Waiting for a self-hosted runner with labels
self-hosted, linux, gpu.* A job that waits a day fails. Jobs that have
waited ten minutes with no matching runner online show under **Needs you**
on Mission control.

`runs-on: { group: GPU, labels: [linux] }` asks for a runner in the group
called GPU as well.

### Labels

Every runner has `self-hosted`, its OS (`linux`, `macos` or `windows`) and
its architecture (`x64` or `arm64`), then the labels you gave it. A runner
that runs jobs in Docker is `linux`, whatever the machine is, since that is
what its jobs run on. Labels are matched without regard to case.

A job takes a runner only when every label in its `runs-on` is one of the
runner's. Labels that name g1t's own machines, such as `ubuntu-latest` or
`g1t-4core`, never go to a self-hosted runner.

### What a job gets

A job on your runner runs exactly as it would in g1t's sandbox: the same
harness, the same `${{ }}` contexts, `GITHUB_*` variables, secrets and
workflow commands, the same log and artifacts. `runner.name`, `runner.os`
and `runner.arch` are the machine's, and `RUNNER_ENVIRONMENT` is
`self-hosted`.

- **In a container** (the default), each job gets a fresh container from
  its `container:` image or the runner's `--image`, removed when it ends,
  with the walls in [what a job's container gets](#what-a-jobs-container-gets).
  In the runner's image under Sysbox, its `services:` and Docker actions
  get [a Docker Engine of its own](#docker-in-jobs).
- **With `--no-docker`** (deprecated), each job gets a fresh folder under
  the work folder, removed when it ends, and runs with whatever the
  machine has installed. A step's default shell is `bash` on Linux and
  macOS and PowerShell on Windows; `shell: pwsh`, `powershell`, `cmd`,
  `bash` and `python` work where installed. On a machine with Docker, the
  job's `services:`, `container:`, `docker://` steps and Docker actions
  use the machine's Docker, as on GitHub's runners.

A self-hosted job stops at 360 minutes unless its `timeout-minutes` says
otherwise, as on GitHub, and can ask for up to 24 hours (1440). Jobs on
g1t's own machines stop at 60 minutes.

## Groups

A workspace's runners are in groups, which say which repositories may use
them. Every workspace has a **Default** group, for every repository, which
runners join unless their token or `--group` names another.

To keep a set of machines for some repositories, open the workspace's
**Runners** page, click **New group**, name it, and choose **Only these**
repositories. Then click **New runner** with that group chosen, or register
with `--group`. Deleting a group moves its runners to the default group.

## Agents on your runners

**Runners → Where work runs** can send g1t's own work to your
runners too: agent runs, checks, reviews, merge checks and the merge queue.
Switch on **Run g1t's work on self-hosted runners** and give the labels
a runner needs to take it (`self-hosted` is always one).

- The agent works exactly as in g1t's sandbox: the same harness, with a
  short-lived credential that can do only what that kind of run may, in
  that repository, revoked when it ends.
- Its model calls still go through g1t's model proxy, `models.g1t.sh`, with
  that credential, so budgets, caps and the audit log work as before. With
  your own [model provider](/guides/models/), g1t charges nothing for the
  run; otherwise the model is paid as usual and the machine is free.
- Agent work needs an image with git, Node, `tar` and the agent's CLI:
  register the runner with `--agent-image` and an image of yours that has
  them. Host mode on a Linux machine set aside for it, where `/work` can be
  written, also works, and is deprecated. g1t does not publish an agent
  image yet.
- [Guardrails](/guides/guardrails/) still apply to what the agent does, but
  their network list cannot be enforced on your machine. The run's session
  says so when it starts.

A project can have its own setting, or follow the workspace's.

## What a run gets from Customize

When g1t's work runs Claude Code on a runner (on g1t's own machines too),
the job gets what the workspace set up in [Customize](/guides/customize/),
as the job's agent would have it. Before Claude Code starts, the runner
reads the workspace's bundle with the job's short-lived agent credential,
once per job, and makes it ready:

| In the bundle | What the runner does | In Claude Code |
| --- | --- | --- |
| Installed plugins that are switched on, each with where to fetch it and the commit it is pinned to | Fetches each at that commit (GitHub's archive of the commit, a clone of the repository here, or the zip the marketplace names) into `/work/.g1t/plugins/<name>/` and passes it with `--plugin-dir`, one flag per plugin | Its skills as `/<plugin>:<skill>`, its subagents as `<plugin>:<agent>`, and its hooks, LSP servers, output styles and `bin/`, which run only here and never on g1t's own agents |
| The library's own skills that reach the agent, as files | Writes them as one more plugin, `g1t-library`, with a `skills/<name>/` folder each, passed with `--plugin-dir` too. A plugin's skills come with the plugin itself | `/g1t-library:<skill>` |
| The connectors that reach the agent and are connected, with the headers that sign them in | Merges each into the `--mcp-config` file's `mcpServers`, by its name, beside g1t's own server | `mcp__<name>__<tool>` |

The run's session gets one line saying what was loaded: *Loaded 2 plugins,
1 library skill and 3 connectors from the workspace's Customize.* A plugin
that could not be fetched, or a bundle that could not be read, is named
there and the run goes on without it; nothing from Customize fails a run.
Plugins from GitHub need `tar` on the machine.

A run on a fork's head loads none of the fork's own settings, hooks, MCP
servers or commands ([guardrails](/guides/guardrails/)). The workspace's
plugins and connectors are the workspace's, not the checkout's, so they are
still passed and merged; but every skill and command is switched off on
such a run, the plugins' and the library's included, so an agent cannot
invoke them there.

The bundle carries the connectors' sign-ins, so only a job's agent
credential or a workspace's token reads it, never a person's:
[`GET /workspaces/{workspace}/customize/bundle`](/reference/api/customize/customize-bundle/),
scope `agents:run`. g1t never keeps or logs it, and the runner keeps the
keys it brought out of the session. See
[what a run gets](/guides/customize/#what-a-run-gets).

## Billing

Time on your runners is free. Each job's minutes go on
[usage](/guides/usage-and-billing/) as **Self-hosted runner time** at $0,
so you can see how much ran there.

- Workflow jobs on your runners need no plan and no card: they work on the
  free tier.
- Agent work on your runners still needs its model paid for: the g1t plan,
  the trial, the open-source pool on a public repository, or your own
  model provider, which makes the run free.

## Security

- **Pull requests from forks never run on your runners** unless you allow
  it under **Runners → Where work runs**. Leave it off on a
  public repository: anyone who can open a pull request could run any code
  on the machine, read what it can reach, and leave something behind for
  the next job. Such jobs get no secrets either way.
- **Secrets** reach a job on your runner under the same rules as on g1t's:
  only trusted runs get them, and only the ones for the job's environment.
- **The runner's credential** can poll for work, report on what it was
  given and remove itself, and nothing else; every other endpoint refuses
  it. It is kept only as a hash on g1t's side, rotates every day, and stops
  working the moment the runner is removed. It is never given to a job:
  each job gets only its own short-lived token.
- **Isolation**: run the runner's image under Sysbox. Each job then gets
  a container of its own inside the runner's container, removed after,
  and neither reaches the machine. A job with `--no-docker` runs as the
  runner's user and can reach whatever that user can; host mode is
  deprecated and refuses public repositories' work. Use ephemeral runners
  for code you do not trust. See [isolation](#isolation).
- **Network**: g1t's network guardrails are not enforced on your machines.
  A job reaches whatever the machine can.
- **Audit**: making a registration token, registering, removing, and every
  job a runner takes are in the [audit log](/guides/audit-log/), with the
  runner as the actor.
- Only owners (or a repository's admins) register and remove runners,
  signed in or with a person's token with `runners:admin`. Workspace
  tokens, `G1T_TOKEN` included, cannot, so a workflow cannot add a machine
  to run its own jobs.

## Docker and Kubernetes

[Run it as a container](#run-it-as-a-container) covers Docker. The image's
settings, besides the register options:

| Variable | |
| --- | --- |
| `G1T_RUNNER_SANDBOX` | `nested` in the image: start a Docker Engine inside the container and run jobs on it. |
| `G1T_RUNNER_DIR` | `/data` in the image: where the configuration and credential are kept. |
| `G1T_RUNNER_UNSAFE_ALLOW_HOST_ACCESS` | `1` starts the runner even when it can reach the machine. See [above](#run-it-as-a-container). |

A runner that ran the image with the machine's Docker socket, as these
docs said before, refuses to start with the new image. Remove the
`-v /var/run/docker.sock:/var/run/docker.sock` and add
`--runtime=sysbox-runc`; the `/data` volume keeps its registration.

### Autoscaling

Ephemeral runners take one job and remove themselves, so each job starts in
a fresh runner container. In Kubernetes with Sysbox installed on the
nodes (its Kubernetes install adds the `sysbox-runc` runtime class), run
them in pods that make their own registration token from an owner's
personal [access token](/guides/authentication/#access-tokens) with only
`runners:admin`, and let the Deployment replace each pod that finishes:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: g1t-runner
spec:
  replicas: 3
  selector: { matchLabels: { app: g1t-runner } }
  template:
    metadata:
      labels: { app: g1t-runner }
      annotations: { io.kubernetes.cri-o.userns-mode: "auto:size=65536" }
    spec:
      runtimeClassName: sysbox-runc
      containers:
        - name: runner
          image: g1t.sh/flagon-io/g1t-runner
          command: ["sh", "-c"]
          args:
            - |
              export G1T_RUNNER_TOKEN="$(curl -fsS -X POST \
                -H "Authorization: Bearer $G1T_ADMIN_TOKEN" \
                https://api.g1t.sh/workspaces/acme/actions/runners/registration-token \
                | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
              exec g1t-runner register-and-run
          env:
            - { name: G1T_RUNNER_URL, value: https://g1t.sh }
            - { name: G1T_RUNNER_LABELS, value: k8s }
            - { name: G1T_RUNNER_EPHEMERAL, value: "1" }
            - name: G1T_ADMIN_TOKEN
              valueFrom: { secretKeyRef: { name: g1t, key: runners-admin-token } }
```

To scale with demand rather than keep a fixed number, change `replicas`
with your autoscaler of choice: [`list_runners`](/reference/api/runners/list-runners-for-workspace/)
says which are busy.

## Updates

The runner checks for a new release every six hours while it is idle, and
updates itself when the release is signed by g1t's release key and its
download matches the release's SHA-256. `g1t-runner update` does it now;
`--no-auto-update` turns it off. Releases are at
`https://g1t.sh/downloads/runner/<version>/`, with a `SHA256SUMS` file.

## Remove a runner

On the machine, `g1t-runner remove` unregisters it and forgets its
credential (run `service uninstall` first if it is a service). Or remove it
from the **Runners** page; the runner stops on its next poll. A job it was
running fails. Runners offline for 14 days are removed by themselves.

## API and MCP

| What | REST | MCP (`workflow` tool) | Scope |
| --- | --- | --- | --- |
| List runners | [`GET /workspaces/{workspace}/actions/runners`](/reference/api/runners/list-runners-for-workspace/), [`GET /repos/{owner}/{name}/actions/runners`](/reference/api/runners/list-runners/) | `list_runners` | `runners:read` |
| Make a registration token | [`POST …/actions/runners/registration-token`](/reference/api/runners/create-runner-registration-token-for-workspace/) | `create_runner_token` | `runners:admin` |
| Remove a runner | [`DELETE …/actions/runners/{id}`](/reference/api/runners/remove-runner-for-workspace/) | `remove_runner` | `runners:admin` |
| Groups | [`GET`](/reference/api/runners/list-runner-groups/), [`POST`](/reference/api/runners/create-runner-group/), [`PATCH`](/reference/api/runners/update-runner-group/), [`DELETE`](/reference/api/runners/delete-runner-group/) `/workspaces/{workspace}/actions/runner-groups` | `list_runner_groups`, `create_runner_group`, `update_runner_group`, `delete_runner_group` | `runners:read`, `runners:admin` |
| Where work runs | [`GET`](/reference/api/runners/get-runner-settings-for-workspace/), [`PATCH`](/reference/api/runners/update-runner-settings-for-workspace/) `…/actions/runner-settings` | `get_runner_settings`, `update_runner_settings` | `runners:read`, `runners:admin` |
| What a run gets from Customize | [`GET /workspaces/{workspace}/customize/bundle`](/reference/api/customize/customize-bundle/) | `customize` tool, `bundle` | `agents:run`, with a job's agent token |

The [Agent preset](/guides/authentication/#scopes) does not include
`runners:read`.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| The job says *Waiting for a self-hosted runner with labels …* | No online runner has every one of those labels in a group that allows the repository. Compare the labels on the **Runners** page, check the runner's group, or start the runner. |
| *Pull requests from forks do not run on self-hosted runners here.* | The run is from a fork. Allow it under **Where work runs**, if you trust everyone who can open a pull request. |
| `register` says the token is not valid | It expired after an hour, or was mistyped. Make a new one. |
| `register` says a runner with that name is registered | Choose another `--name`, or add `--replace`. |
| `run` says *g1t no longer knows this runner* | It was removed, or its credential was. Register it again. |
| *this runner is not sandboxed from its machine, so it will not take work* | The runner's container can reach the machine: it lists why. Remove the machine's Docker socket and `--privileged`, and run it with `--runtime=sysbox-runc`. See [run it as a container](#run-it-as-a-container). |
| *the runner's own Docker Engine could not start* | The container is not running under Sysbox. Add `--runtime=sysbox-runc`, and check that Sysbox is installed (`docker info` lists `sysbox-runc` under runtimes). |
| *… is public, and this self-hosted runner runs jobs directly on its machine* | A runner in host mode does not take public repositories' work. Run the runner's image under Sysbox. |
| A step's `sudo` fails | Job containers have `no-new-privileges`. Steps run as the image's user, root in most CI images, so drop the `sudo`. |
| *could not run docker* | Install Docker and start it, and give the runner's user access to it. |
| Agent work fails at once | Give the runner `--agent-image`. |
| The runner is offline in the list | It has not polled for 90 seconds. Check its log (`journalctl -u g1t-runner-<name>`, `~/.g1t-runner/runner.log`, or the terminal) and that the machine can reach `https://api.g1t.sh`. |
