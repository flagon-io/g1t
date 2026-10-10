---
title: Self-hosted runners
description: Run your workflow jobs, and if you choose your agents' work, on your own machines. Their time costs nothing.
---

A self-hosted runner is a machine of yours that runs your workflow jobs
instead of g1t's sandboxes. It can be a server, a Mac in a cupboard, a
Windows box with a GPU, or a pod in your cluster. You install `g1t-runner`
on it, register it once, and it picks up jobs that ask for it with
`runs-on: self-hosted`.

- **Time on your runners is $0**, on every plan, including the free one.
  It shows on [usage](/guides/usage-and-billing/) as self-hosted minutes.
- **It only connects out.** The runner polls `api.g1t.sh` over HTTPS for
  work. Nothing needs to reach the machine: no open port, no tunnel.
- **Any OS.** Linux, macOS and Windows, on x64 and arm64. Jobs run in a
  Docker container by default, or directly on the machine.

| Where | Page | Who manages it |
| --- | --- | --- |
| A workspace | **Workspace → Runners** in the rail, `g1t.sh/<workspace>/-/runners` | Owners only. |
| A project | **Settings → Runners**, `g1t.sh/<workspace>/<project>/settings/runners` | People with the Admin [role](/guides/access-and-roles/) on its repository |

A workspace's runners serve the repositories their [group](#groups) allows.
A project's own runners serve only that project.

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

### Register options

| Option | |
| --- | --- |
| `--url` | The g1t you register with: `https://g1t.sh`. |
| `--token` | The registration token. |
| `--name` | What to call it. The machine's name if left out. Names are unique within a workspace (or project). |
| `--labels` | Extra labels, comma-separated: `gpu,cuda-12`. See [labels](#labels). |
| `--group` | A workspace runner's [group](#groups). The default group, or the one the token was made for, if left out. |
| `--ephemeral` | Take one job, then remove itself. For [autoscaling](#autoscaling). |
| `--no-docker` | Run jobs directly on the machine instead of in containers. |
| `--image` | The image workflow jobs run in when they name no `container:`. `node:24-bookworm` if left out. |
| `--agent-image` | The image [agent work](#agents-on-your-runners) runs in. |
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

- **In Docker** (the default), each job gets a fresh container from its
  `container:` image or the runner's `--image`, removed when it ends. The
  runner needs Docker, and its user needs to be allowed to use it. Its
  `services:` are not started, since the job's container has no Docker of
  its own; the log says so.
- **With `--no-docker`**, each job gets a fresh folder under the work
  folder, removed when it ends, and runs with whatever the machine has
  installed. A step's default shell is `bash` on Linux and macOS and
  PowerShell on Windows; `shell: pwsh`, `powershell`, `cmd`, `bash` and
  `python` work where installed. On a machine with Docker, the job's
  `services:`, `container:`, `docker://` steps and Docker actions use
  the machine's Docker, as on GitHub's runners.

A self-hosted job stops at 60 minutes unless its `timeout-minutes` says
more, up to 24 hours (1440). Jobs on g1t's own machines stop at 60 minutes.

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
- Agent work needs an image with git, Node and the agent's CLI: register
  the runner with `--agent-image` and an image of yours that has them, or
  run it with `--no-docker` on a Linux machine set aside for it, where
  `/work` can be written. g1t does not publish an agent image yet.
- [Guardrails](/guides/guardrails/) still apply to what the agent does, but
  their network list cannot be enforced on your machine. The run's session
  says so when it starts.

A project can have its own setting, or follow the workspace's.

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
- **Isolation**: a job in Docker gets a container of its own, removed after.
  A job with `--no-docker` runs as the runner's user, in a folder of its
  own; it can reach whatever that user can. Use a dedicated account, and
  ephemeral runners for untrusted code.
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

The runner's image runs `register-and-run`, which registers once and then
runs. Each option can also come from `G1T_RUNNER_<OPTION>` in the
environment, such as `G1T_RUNNER_TOKEN` and `G1T_RUNNER_LABELS`, so a
secret can hold the token:

```sh
docker run -d --name g1t-runner --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v g1t-runner:/data -e G1T_RUNNER_DIR=/data \
  g1t.sh/flagon-io/g1t-runner register-and-run --url https://g1t.sh --token g1trt_…
```

With the host's Docker socket, each job runs in a sibling container.

### Autoscaling

Ephemeral runners take one job and remove themselves, so each job starts on
a clean machine. In Kubernetes, run them with `--no-docker` in pods that
make their own registration token from an owner's personal
[access token](/guides/authentication/#access-tokens) with only
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
    metadata: { labels: { app: g1t-runner } }
    spec:
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
            - { name: G1T_RUNNER_NO_DOCKER, value: "1" }
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
| *could not run docker* | Install Docker and start it, give the runner's user access to it, or register with `--no-docker`. |
| Agent work fails at once | Give the runner `--agent-image`, or run it on Linux with `--no-docker`. |
| The runner is offline in the list | It has not polled for 90 seconds. Check its log (`journalctl -u g1t-runner-<name>`, `~/.g1t-runner/runner.log`, or the terminal) and that the machine can reach `https://api.g1t.sh`. |
