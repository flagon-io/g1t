# g1t plan

g1t is where people and agents ship software together: a git platform built on Cloudflare Workers and Artifacts for
the "Build the Next-Gen Git Platform on Cloudflare" competition.

- Submission closes **October 14, 2026, 11:59 PM PDT**: a 5–10 minute demo
  video, this repository (MIT) and run instructions.
- Judging: 50% originality and quality of the prototype for agent-oriented
  collaboration; 25% multi-agent concurrency, coordination, context
  preservation, review and conflict handling; 25% ease of use.

## The point

**g1t is where a team of agents ships code, with the people they work for.**

Hosting git is table stakes, and g1t does it the familiar way: issues,
branches, pull requests, review, protected branches, people working by hand.
None of that is the selling point. The selling point is the layer above it,
which no forge has: **you hand g1t an outcome, and a fleet of agents converges
it onto `main`, coordinating with each other and with you, with every decision
on the record.**

Three things only g1t does, and every feature should serve one of them:

1. **Outcomes, not pull requests.** The unit people work in is "make onboarding
   work offline", not branch #4012. A brief becomes a plan of issues with
   dependencies; agents take them as they unblock; people steer the outcome
   and see it converge, rather than stopping at the pull request.
2. **Agents that work as a team.** Agents know what the others are doing, file
   what they find instead of widening their change, ask and answer each other
   through the forge, and defer to people. Many agents on one codebase without
   a human refereeing collisions.
3. **`main` that only ever moves forward.** Every change lands through checks
   in the combination it will live in (the merge queue), failures go back to the
   agent that wrote them, and any line can answer "why is this here?"

## Product model

g1t keeps the two things every engineer already knows, issues and pull
requests, and changes the assumption underneath them. A forge built for
people expects a few changes in flight, each watched by its author. g1t
expects dozens of agents working at once across a project, each on its own
issue, all of which have to land on `main`. A person assigns an issue to
g1t and chooses nothing else: not how many agents, and not which
model. An issue can still collect more than one pull request (a second
attempt, or someone's own agent alongside g1t's), and when it does the
issue records which one was taken.

| Concept | What it is |
| --- | --- |
| **Issue** | What should change in a repo: a bug, a feature, a question. Opened by a person, an agent or an integration such as an error tracker. Carries labels, a description that may say what done means (a Definition of done: context, never a gate), comments, and every pull request made for it. What a merge needs is the default branch's required checks: workflow statuses, the same for people and agents. |
| **Pull request** | A proposed change in its own Artifacts fork, made by an agent or a person, usually for an issue. Any number can be open for one issue. Starts as a draft; marked ready; merged or closed. |
| **Session** | The agent's full context for a pull request: prompt, messages, tool calls, cost. Stored with the pull request and linked from every commit it produced. |
| **Compare view** | Every pull request for an issue side by side with diff, check results, conflicts against main and against each other, and a reviewer agent's summary. |
| **Merge** | A person or a policy picks a pull request. A per-repo merge queue lands it. The issue closes, recording which pull request resolved it; the others for that issue close as superseded, or are rebased by their agents when the issue is kept open. |

Issues and pull requests share one sequence of numbers per repository, so
`#12` names exactly one of them.

Features that fall out of the model:

- **Why-blame.** Click a line and see the prompt and reasoning that produced
  it, not only the commit.
- **Overlap radar.** Pull requests that touch the same files are flagged
  while the agents are still working, and the agents are told.
- **Live lanes.** Watch every pull request progress in real time.

## Why issues and pull requests, not something new

An earlier version of this plan merged the two into one new object, an
"issue" holding "pull requests". That was wrong, for three reasons.

- **Issues come from everywhere.** People file them, agents file them, and
  Sentry files them. Most are never worked on by whoever opened them. They
  need their own life: labels, triage, discussion, closing as not planned.
- **"Which change did we take?" needs two objects.** When five agents each
  propose a change, the answer has to be recorded somewhere other than the
  five proposals. On g1t it is on the issue: `resolved by #14`.
- **Nobody should have to learn a word to use the product.** An engineer who
  has used any forge can use g1t on the first day, and finds the agent
  features where they would look for them.

What g1t adds to the familiar pair:

- **Several pull requests per issue is supported**, not an accident. It
  is the exception, for a second attempt or a competing one, but when it
  happens the issue's page lists them with their state, and merging one
  closes the issue with that pull request recorded and the others marked
  superseded.
- **A pull request can be part of the work.** Merging with "keep the issue
  open" leaves the issue and its other pull requests alone.
- **Every pull request has a fork and a session.** See
  [forks and branches](https://docs.g1t.sh/concepts/forks/).
- **Labels need no setup.** A repository starts with the default labels
  (`bug`, `documentation`, `enhancement`, `question`, `dependencies`,
  `security` and the rest), each with a color and a description, on issues
  and pull requests alike; someone with Triage makes a new one as they use
  it. **Milestones** gather issues and pull requests under a goal and a
  due date. Pull requests can merge into any branch; the default branch's
  protection holds only for those into it.
- **The developer path is unchanged.** Push a branch, open a pull request
  from it, get review, merge. Agents get a fork per pull request instead.
- **Both paths meet at `main`.** The same landing rules apply to a person's
  pull request and an agent's.

## Converging on main

Twelve issues started together will finish at different times and touch
overlapping code. Getting them all into `main` without a person refereeing
is the hard part, and it is handled in four places.

1. **Before work starts: plan the overlap away.** A project is a graph of
   issues. A planner agent can split a large goal into issues, predict
   which files each will touch, and add a dependency where two would collide,
   so one starts from the other's result instead of from `main`.
2. **While agents work: overlap radar.** Each pull request's changed files and
   symbols are tracked as it pushes. When two pull requests from different issues
   enter the same area, both agents are told what the other is doing there.
3. **When `main` moves: the author resolves.** Every open pull request is
   trial-merged against the new `main`. A clean merge updates the pull request
   silently. A conflict resumes that pull request's agent with its original
   session and the incoming change, so the conflict is resolved by the agent
   that wrote the code and still knows why.
4. **At landing: a speculative queue.** Approved pull requests enter the
   repo's queue. g1t builds the combined states (`main`+A, `main`+A+B, …) and runs
   their checks in parallel. Pull requests land in order as their combined state
   passes; one that fails is ejected back to its agent and the states behind
   it are rebuilt. `main` only ever receives a state that passed.

Landing can be fully automatic: a repo policy such as "checks pass and the
reviewer agent approves" merges without a person.

## Agents aware of each other

Each repo keeps a live **work registry**: for every running pull request, its
issue, a running summary of what it has done, and the files and symbols it
has touched or plans to touch. Agents use it through MCP tools; g1t also
acts on it without being asked.

- **Before starting.** When an issue is opened, or an agent is about to
  begin a task, g1t searches open issues and running pull requests for the same
  goal (by meaning, not wording) and for the same area of code. If a match
  exists the agent is told who is on it and how far along, and chooses: join
  as a deliberate racer, wait for the result, or drop the task. Duplicate
  issues are offered for merging.
- **Finding out-of-scope work.** An agent that discovers something outside
  its issue asks the registry who works there. If another pull request owns that
  area, it **hands off**: a note, the relevant excerpt of its session, and
  optionally commits the receiver can take. If nobody does, it opens a child
  issue instead of widening its own change.
- **Asking.** An agent can put a question or a request to another pull request.
  The receiver gets it at its next turn.
- **Waiting.** An agent that needs another pull request's result parks itself.
  Its sandbox sleeps, spend stops, and it resumes from the new state when
  that pull request merges.
- **Agents that do not cooperate.** For pushes from tools that never call
  these tools, g1t compares the pushed change against running pull requests and
  flags near-duplicates itself.

Every handoff, question and wait has a state (offered, accepted, declined,
done), appears in the timeline, and is visible to people. A handoff declined
twice, or two agents passing work back and forth, goes to the "needs you"
inbox.

## Review at scale

Cloudflare's brief asks "how do you review everything they produce?". With
hundreds of agents, a person cannot read every diff, so review is by
exception.

- **Evidence, not diffs.** Every pull request carries a proof bundle: checks run
  and their output, a preview URL, a plain-language summary, and the
  behaviour that changed.
- **Two agent reviewers.** One reviews the change against the issue. A
  second is adversarial: it tries to break the change and reports what it
  found.
- **Risk tiers.** Each change is scored from what it touches, how large it
  is, and how the reviewers ruled. Low risk merges on policy; high risk goes
  to a person with the evidence already assembled.
- **Trust is earned.** An agent's record on a path (merged, reverted, caught
  by review) raises or lowers the tier its changes land in.
- **Sampling.** A share of auto-merged changes is sent to a person anyway,
  to keep the policy honest.

## Rethinking the git primitives

- **No branches for agents.** A pull request is a fork; `main` is the only
  long-lived line. There is nothing to name, clean up or go stale.
- **Projected main.** New pull requests start from `main` plus everything already
  in the landing queue, so they are built on the state they will land on.
- **Structural merge.** The merge engine merges by syntax tree, not by line,
  for supported languages. Two agents adding different functions to the same
  file do not conflict.
- **Forkable sessions.** A session can be forked at any turn: the code as it
  was at that moment plus the conversation up to it, continued with a
  different instruction. Branching applies to the reasoning as well as the
  code.
- **Provenance in history.** Every commit records its issue, session,
  agent, model and cost, and is signed with a key issued to that pull request. The
  history can be audited by machine.

## People in the loop

### Code that arrives from outside

People will keep pushing with plain git, their editor, or another tool. Every
push goes through g1t's git front end, so none of it bypasses the model.

- **A push to a branch becomes a pull request.** g1t adopts it with the pusher as
  author. A reviewer agent writes the issue it appears to serve and offers
  to attach it to an open issue it matches. From there it gets the same
  checks, compare view and queue as agent work.
- **A push to `main` follows repo policy.** Protected: refused with a message
  saying which ref to push to instead, so it enters the queue. Open: accepted
  and treated as "`main` moved", which re-verifies the queue and triggers
  resolve-on-move for every open pull request.
- **Context is an open format.** A commit trailer names the session that
  produced it, so any tool can attach its transcript. Commits without one are
  shown in why-blame as "pushed by a person, no session".
- **Approval rules.** Per repo and per path: merge automatically, require a
  named person, or require a person when the change is large or the reviewer
  agent is unsure.

### Joining work that is already running

- **Every session has a live page** that works on a phone: the transcript as
  it streams, the current diff, check results.
- **Steer.** Send a message, pause, or redirect. Hosted agents receive it
  immediately; a person's own Claude Code receives it at its next turn
  through the CLI hooks.
- **Answer.** When an agent is blocked on a question, it appears in a "needs
  you" inbox and as a notification. The answer resumes the agent.
- **Take over and hand back.** Check out the pull request's fork, commit by hand,
  push, and let the agent continue from there.

### Planning by writing

- **Brief.** Write the outcome in prose on the site, or commit it as a
  markdown file. A planner agent turns it into a project: issues, each with
  what done means, and dependencies. The person edits the graph before anything starts.
- **Plan from their own agent.** The same operations are MCP tools, so a
  person can plan in their own Claude Code session and create the project
  from there.
- **The brief stays the source of truth.** Editing it later re-plans: new
  issues are added, obsolete ones are closed.

### Seeing what moved

- **Project page.** The outcome, the issue graph coloured by state, and how
  many of its issues have landed with their required checks passing,
  compared with when the project started.
- **Digest.** An agent-written summary per project and per person: what
  merged, what is blocked on whom, which conflicts were resolved, what it
  cost.
- **Timeline.** Every event (push, steer, check, conflict, merge) in order,
  each linked to the session and the person or agent behind it.

## One session, any surface

A session belongs to g1t, not to the device it started on. The browser, a
phone and Claude Code are views of the same session.

- **Browser and phone.** The site is a responsive, installable web app with
  push notifications. Everything a person does (brief, steer, answer,
  approve, merge) works there.
- **Claude Code.** Through `mcp.g1t.sh` and the CLI hooks, a local session is
  a g1t session: its transcript syncs as it runs and it appears in mission
  control like any other.
- **Moving a session.** A local session can be sent to the cloud: a hosted
  agent takes over the fork and the transcript and continues, so the laptop
  can close. A hosted session can be pulled down: the CLI checks out the fork
  and resumes it in local Claude Code with its history.
- **Limit.** A session running only on a laptop stops when the laptop does.
  It can be steered between turns but not continued until it is moved or the
  laptop is back.

## For people who do not write code

- **Documents are first-class.** Specs, guides, policies and decisions live
  in repos as markdown, shown in a Docs view: rendered pages, edited in the
  browser like a document, with inline comments. "Suggest a change" is an
  pull request and "publish" is merge, without git vocabulary.
- **Document issues.** "Write the onboarding guide for the billing API" is
  an issue. Its Definition of done is a checklist judged by a reviewer agent
  instead of a workflow. Agents draft and revise; people comment and approve.
- **Templates.** Product brief, RFC, decision record. A filled-in template is
  a brief the planner can turn into a project.
- **Explain.** Ask about any repo, project or change in plain language and
  get an answer with links to the code and sessions behind it.
- **Living documentation.** g1t generates "how this works" pages from the
  code and keeps them current. When a merged change contradicts a document,
  an issue opens to update it.
- **See it, don't read it.** Every pull request on a deployable repo gets a
  preview URL (Workers Builds from the pull request's fork), so an approver clicks
  through the result instead of reading a diff. Changes are also summarised
  in plain language.
- **Roles.** A person can plan and approve work without ever cloning a
  repo. The roles that were sketched here map onto the five repository
  roles that are built (see "Access" under what is built): a viewer is
  Read, a commenter is Read (anyone with Read opens issues and comments),
  a planner is Triage (labels, milestones, assigning, closing) or Write
  where planning spends compute, and an approver is Write (reviews count
  and merges). Workspace-wide, a member may also be a billing manager or a
  security manager.

## The macro view

The hierarchy above a single repo:

| Level | What it is |
| --- | --- |
| **Workspace** | A company or team: its people, repos, agents, budget and policies. |
| **Initiative** | A business outcome with an owner and measurable results, e.g. "move billing to usage-based pricing". Spans any number of repos. |
| **Outcome** | One deliverable inside an initiative: a brief and its graph of issues (shown as **Plan**). Called "project" before 2026-10-04; that name now means what [Projects](#projects) describes. |
| **Issue / Pull request** | As above. An issue may touch several repos; a pull request for it then holds one fork per repo and they land together. |

How it feeds up, and what is built:

- **A workspace is the unit everything belongs to.** Repositories, people,
  access tokens, and later projects, budgets and policies are the
  workspace's, never a person's. An account owns nothing; its first step
  after confirming its email is creating a workspace, and the site sends it
  there from wherever it was going.
- **One namespace.** Usernames and workspaces share one set of names, as on
  Docker Hub and npm. A username is reserved for its owner's workspace, so
  `g1t.sh/<name>` never means two things.
- **The workspace page is the roll-up.** `g1t.sh/<workspace>` shows its
  repositories with their open issues and pull requests, and the pull
  requests in progress across all of them. Projects and initiatives will
  roll up to the same page. Its own pages live under `/<workspace>/-/`
  (people, access tokens, settings), which no repository can be named.
- **Workspace access tokens instead of service accounts.** A workspace has
  tokens of its own, in the same table and code path as personal ones. One
  acts as the workspace, with a member's rights in that workspace only,
  records who made it and when it was last used, and keeps working when
  that person leaves. CI, integrations and automations use these.

### Portfolio

One page answers "where is the business" across every initiative:

- **Health** per initiative: on track, at risk, or blocked, derived from
  facts (checks passing, issues stalled, questions waiting on a person),
  not self-reported.
- **Progress** as measurable results: required checks passing, issues
  merged out of planned, and the trend since the start.
- **Forecast** from actual throughput: at the current rate, when the
  remaining issues land.
- **Spend** in tokens and dollars against a budget, per initiative.
- **Waiting on people**: every decision or approval a person owes, by name.
- **Roadmap**: initiatives laid out as now, next, later, with optional
  time-boxed cycles for teams that work in sprints.

### Status without asking

- **Standup.** An agent writes a daily report per initiative and one for the
  whole workspace: what merged, what changed direction, what is at risk and
  why, what needs a person. Delivered by email or webhook.
- **Ask.** A question box over the full event log and all sessions: "what
  happened on the billing migration since Monday?" answers with links to the
  sessions and commits behind each claim.

### Long-running agents

Work that runs for days needs supervision that does not depend on someone
watching.

- **Checkpoints.** A long pull request reports milestones against its issue, so
  progress is visible before anything merges.
- **Stall and drift detection.** A pull request with no meaningful progress, or
  whose changes have wandered away from its issue, is flagged and can be
  stopped or re-briefed automatically.
- **Budgets.** Hard limits on spend and time per pull request, project and
  initiative.

### Context hub

Agents working across repos and days need context that outlives any one
session and reaches beyond the code. The context hub is one place an agent
asks, whatever the source.

| Source | What it holds | How it gets there |
| --- | --- | --- |
| **Memory** | Decisions, conventions, gotchas, facts about systems | Written by agents and people in g1t |
| **Code and sessions** | The repos, and the reasoning behind every change | Already in g1t |
| **Connected sources** | Jira and Linear tickets, Notion and Confluence pages, Google Drive documents, Slack threads, Sentry issues | Connectors, authorised per workspace |

How it behaves:

- **One search.** An agent asks a question and gets ranked results across
  all sources, each labelled with where it came from, who wrote it, and how
  fresh it is.
- **Connected sources stay where they are.** g1t indexes them for search and
  fetches the current version when an agent opens one. The external system
  remains the source of truth, and a link placed on an issue ("see
  JIRA-482", a Notion URL) is pulled into the agent's starting context.
- **Permissions carry over.** A connector only exposes what the connecting
  account can see, and a workspace admin chooses which spaces, projects or
  channels are included.
- **External content is untrusted.** A ticket or page can contain text meant
  to manipulate an agent. It is marked as reference material, never treated
  as instructions.
- **Documentation is separate.** Context is what agents know; documentation
  is what people read, and it is generated from context and code.

Memory is the part of the hub that g1t owns and agents write to:

- **Memory is written freely.** Any agent or person adds an entry with one
  call: a decision, a convention, a gotcha, a fact about a system. No review
  gate. Each entry records who wrote it, from which session, and when.
- **It is still a repository.** Each workspace has a memory repo in
  Artifacts, so every write is a commit: versioned, attributable, and
  revertible.
- **It is kept healthy by an agent.** A consolidation agent merges
  duplicates, retires entries that newer ones contradict, and flags
  conflicts it cannot settle. People can pin an entry (agents may not change
  it), correct it, or retract it.
- **Agents read it.** Every session starts with the context relevant to its
  issue, found by search, and can query more through MCP.
- **Updates are events.** A memory write or a change in a connected source
  is an event, so "when context changes, update the affected docs" is an
  automation, on by default.
- **It is scoped inside the workspace.** Some context applies to the whole
  workspace, some to one initiative, project or repo, so an agent gets what
  applies to its work.
- **It never crosses workspaces.** A workspace is the isolation boundary: its
  context, sessions and private repos are invisible to every other
  workspace, and an agent's token is bound to one workspace.

## Working in g1t

- **Mission control.** The signed-in home page: every running session, every
  issue waiting on a decision, and what merged, across all repos.
- **Outcomes.** Group issues across repos toward one result and track how
  many are open, racing, or merged. (What [Projects](#projects) means is
  below.)
- **Steering.** Send a message to a running pull request, or to all pull requests on an
  issue at once, without stopping them.
- **Automations.** Rules that start work without a person (next section).

## Automations and integrations

> **2026-10-03:** g1t's own `.g1t/automations` format was built and then set
> aside at the user's request ("let's just copy GitHub Actions on that for the
> time being"). Automation on g1t is GitHub Actions workflows in
> `.g1t/workflows/`; the format below is kept for later.

An automation is **when** an event happens, **if** conditions hold, **do**
something. They are defined as files in the repo (`.g1t/automations/`), the
way GitHub Actions workflows are, and can also be built in the UI.

### Events that can trigger one

| Source | Examples |
| --- | --- |
| Git | push, merge, check failed, `main` moved |
| g1t | issue opened, pull request stalled, context updated, handoff declined, budget reached |
| Time | cron schedule |
| Integrations | Sentry issue, PagerDuty incident, Linear or Jira ticket, Slack message or mention, GitHub issue, Stripe event |
| Anything else | a signed generic webhook, or an email to a per-repo address |

**Actions**: open an issue (optionally assigning N agents to it), message
a running pull request, update documentation, notify, call a
webhook, write back to the source system.

**Example: Sentry.** A new production error arrives. The automation opens an
issue labelled `bug`, with the stack trace, release and frequency in its
description. Why-blame
finds the session that wrote the failing line, so the fixing agent starts
with the original reasoning. When the fix merges, g1t comments on the Sentry
issue and resolves it.

### Rules every automation obeys

- **Deduplication.** The same Sentry issue firing 500 times maps to one
  issue.
- **Limits.** Concurrency and budget caps per automation.
- **Loop protection.** Work started by an automation cannot retrigger the
  same automation without a person in between.
- **External input is untrusted.** A webhook payload can contain text written
  by an attacker. Agents started by external events run with reduced
  permissions and cannot merge without the repo's approval rule passing.

**Checks** are the other half of what GitHub Actions does: build and test
commands declared in `.g1t/checks.yaml`, run in sandboxes on every pull request
and on every combined state in the landing queue.

### Docker in workflow jobs (built 2026-10-08)

> **2026-10-08:** "Why didn't we give CI docker then? We need GitHub
> Actions functionality maxxed baby but with all the good good security
> etc." The trigger: `deploy.yml`'s runner-image job needs `docker build`
> and `docker push`, and failed on hosted runners.

**What Cloudflare Containers allow** (their FAQ, updated 2026-10-05, and
the Docker-in-Docker guide and example it links):

- Docker runs inside a container: `docker:dind`, with `dockerd` as
  **root**. A rootless Engine does not start there.
- **No iptables**: `--iptables=false --ip6tables=false`, or the Engine
  fails setting up its rules. Containers with the `durable_object`
  scheduling policy (ours: each sandbox is a Durable Object's) cannot turn
  IP forwarding on either: `--ip-forward=false`, or the Engine exits.
- So **a bridge network has no way out**: the guide's answer is
  `--network=host` for `docker run` and `docker build`, which gives
  containers the outer container's network.
- Built images and containers are lost when the sandbox stops.

**What was found by trying** (Docker Engine 29.8.2 in a privileged
container standing in for a sandbox, with the same flags):

- `--bridge=none` makes BuildKit's `RUN` steps fail outright ("network
  bridge not found"); with the default bridge they run with no route out.
  Containers default to the bridge too. The default bridge is created
  fine without iptables, as the FAQ's own example relies on.
- The overlay snapshotter does not work on an overlay root filesystem, and
  the containerd image store does not fall back by itself: the Engine
  starts, then every container fails to mount. Whether a sandbox's disk
  takes overlays is not documented, so the runner tries a mount first and
  uses `native` (plain copies) when it fails. `vfs` is not a name the
  containerd store accepts.
- `--cpus` and `--memory` need cgroup v2 controllers handed down from a
  cgroup with no processes, which `docker:dind`'s entrypoint does and a
  plain `dockerd` does not.
- A `runc` earlier on the Engine's `PATH` is used both for containers (via
  containerd's shim) and by BuildKit's executor, with the bundle's
  `config.json` written before it runs. BuildKit's bridged steps carry
  libnetwork's `libnetwork-setkey` prestart hook; `RUN --network=none`
  does not.
- Buildx skips `type=gha` caches when the job has no GitHub cache service,
  and the build succeeds without one.
- Registries' layer hosts: Docker Hub sends layers from
  `production.cloudfront.docker.com` (and `production.cloudflare.docker.com`),
  Quay from `cdn0N.quay.io`, Microsoft's from regional
  `*.data.mcr.microsoft.com`, public ECR from a CloudFront host;
  `mirror.gcr.io` serves its own.

**What was built** (`crates/runner/src/docker`, `actions/containers.rs`):

- **One Engine per job, started lazily.** The runner listens on
  `/var/run/docker.sock` itself and starts `dockerd` (root, the flags
  above, containerd image store, `mirror.gcr.io` first for Docker Hub) on
  the first connection, or when the job has `services:` or `container:`.
  A log line says it started and how long it took.
- **Containers on the job's network.** The socket is an API proxy: a
  container that asks for a bridge or user network gets `host`; its names
  (container name, aliases, Compose service, links) resolve to 127.0.0.1
  in later containers (`ExtraHosts`) and in the job's steps
  (`/etc/hosts`); `-p 8080:80` is forwarded; `docker inspect` reports the
  ports as published; `network connect` adds aliases. Sharing the job's
  network is also what keeps the guardrails on every container: the
  egress Worker sees their traffic as the job's.
- **A `runc` shim.** The runner binary, as `runc`: BuildKit steps bound for
  a bridge lose the network namespace and the libnetwork hook (so they use
  the job's network); in a guarded job every container (run, exec, build
  step) gets the egress certificate at `/dev/g1t-egress` and the
  variables that point tools at it. `/dev` is the container's own tmpfs,
  so none of it lands in a layer; checked by saving a built image.
- **Job features:** `services:` (pull, credentials, health waits, logs at
  the end, `job.services.*`), `container:` (steps and JavaScript actions
  through `docker exec`, Node mounted from the runner, Alpine falls back to
  running actions beside it), `docker://` steps and Dockerfile actions in
  GitHub's `/github/*` layout, `docker/setup-buildx-action` answered
  natively (the job's Engine is the builder), sign-in to g1t's registry
  with the run's token.
- **Kill switch:** the runner Worker's `DOCKER` var (`off`).

**Rejected:** rootless Docker or BuildKit (does not start in Containers);
Podman or buildah with `vfs` (no better networking, less compatible, slow);
a standalone `buildkitd --oci-worker-net=host` as the default builder
(images not in the Engine's store, so `FROM` a just-built image and
`docker run` of a build fail without `--load` round trips); a `docker` CLI
wrapper adding `--network=host` (misses Compose, SDKs and testcontainers,
which speak the API).

**Not yet:**

- Seen on Cloudflare itself: whether a sandbox's disk takes overlays,
  `--privileged`, and the first deploy's pull of the base from
  `registry.cloudflare.com` (its layer host may need a workflow-only line).
- `type=gha` build caches backed by g1t's Actions cache.
- Multi-platform builds (QEMU's `binfmt_misc` in a sandbox).
- Docker for agents and checks, not just workflow jobs.
- `runner-base.yml` on g1t's machines: the base's apt step needs
  `Acquire::https::CAInfo` pointed at the egress certificate first.
- A deploy that appends the runner binary as a layer through the registry
  API, with no Docker and no 3 GB pull.

Agents can also reach integrations directly: an agent definition lists MCP
servers (Sentry, Linear and so on) it may use while working.

### Workflows: the toolkit, OIDC and artifacts

> **2026-10-08:** built so that workflows that deploy, cache and pass files
> run unmodified.

- **The toolkit's services.** Every job gets `ACTIONS_RUNTIME_TOKEN` (a
  JWT whose `scp` names its run and job, signed with a key derived from
  the job's own token, so nothing new is kept), `ACTIONS_RESULTS_URL`,
  `ACTIONS_CACHE_URL` and `ACTIONS_CACHE_SERVICE_V2`. The API answers the
  cache's Twirp service (v2) and its older REST protocol, the artifact
  Twirp service, and the signed blob links they hand out (a subset of
  Azure Blob's protocol mapped onto R2 multipart uploads), from the same
  cache and artifact rows g1t's own runner uses. As the clients' source
  reads, `@actions/cache` and `@actions/artifact` treat any server
  but github.com as GitHub Enterprise Server, so the cache client speaks
  the older protocol and the artifact client refuses to run. g1t's runner
  therefore keeps handling `actions/upload-artifact`, `download-artifact`
  and `upload-artifact/merge` itself; the Twirp artifact service is there
  for clients that do not check.
- **OIDC.** The issuer is `{API}/actions/oidc`, the API's own host, with
  discovery, JWKS (RFC 7638 `kid`s, a previous key published while
  rotating) and a token endpoint for `core.getIDToken`. Claims follow
  GitHub's. A job gets one only when its permissions (or its workflow's)
  give `id-token: write`, and never for an untrusted run. The permission
  check reads only `id-token` (`services/actions/src/runtime.rs`,
  `id_token_permitted`), the seam for the full `permissions:` model.
- **Artifacts** moved from KV to R2 (`a/` in the cache bucket), with rows
  in the actions service: numeric ids, 5 GiB each and 10 GiB a run,
  zipped by the runner, `retention-days` up to the repository's setting
  (1 to 90, 14 by default), `overwrite`, `compression-level`, patterns,
  merging and other runs of the same repository. The REST artifacts API and
  the `workflow` tool's artifact actions follow GitHub's shapes; the run's
  page lists them with size and expiry, with download and delete. Their
  storage is charged with the cache's.
- **Later:** the toolkit's older artifact protocol (`upload-artifact@v3`
  inside other actions), downloads from other repositories, and npm
  trusted publishing, which depends on npm accepting g1t's issuer.

## A repository that maintains itself

> **2026-10-04:** the user asked for Dependabot, GitHub Advanced Security and
> Vercel-style deployments, "so you're not having to maintain shit and you're
> just pushing up agents that are delivering work consistently".

GitHub reports problems and leaves the fix to you. In g1t, an agent opens an
issue for each problem, writes the fix, runs its checks, links a preview and
lands it through the queue. People only decide.

### Upkeep agents

- **Dependency updates.** The file is `dependabot.yml` version 2, read from
  the default branch at `.g1t/dependabot.yml` (or `.yaml`), then
  `.github/dependabot.yml` (or `.yaml`); `.g1t/` wins when both exist, and
  an imported repository's file works unchanged. Every option is read and
  checked, each problem reported with its line and key on the Security page
  and as the `g1t / dependabot.yml` status on pull requests that change the
  file; a file with problems is not acted on.
  - **Built (2026-10-07):** version updates for npm, cargo, gomod and pip:
    schedules (all intervals, cron and natural phrases, time zones, a
    picked time per repository), allow, ignore, cooldown (3 days by
    default), groups (including across directories and `group-by`),
    versioning strategies, open-pull-requests-limit, commit-message,
    branch names, rebase-strategy, assignees, reviewers, private
    registries filled from workflow secrets (npm, cargo, Go proxy, Python
    index), and the `@g1t` comment commands. Pull requests come from g1t
    with an `updated-dependencies` commit record and land through the
    required checks; one that fails them is closed and becomes a
    "needs code changes" issue assigned to g1t.
  - **Security updates follow the same file:** ignore (and comment
    ignores), allow names, `applies-to: security-updates` groups,
    commit-message, assignees, reviewers, labels and milestone. Cooldown
    and the open pull request limit do not apply. The Security updates
    switch still turns them on and off.
  - **Labels, milestone and target-branch** are applied to version
    updates: `dependencies` and the ecosystem's label by default, missing
    labels created; `target-branch` updates are made from that branch and
    merge into it.
  - **Not done yet:** one pull request for a multi-ecosystem group
    (it opens one per ecosystem); registries that sign in with OIDC;
    updating vendored copies; and version updates for the other
    ecosystems (bundler, composer, docker, github-actions, gradle, maven,
    nuget, terraform, uv and the rest are read and checked only).
- **Secret scanning.** Pushes are scanned for known token formats. A push
  that adds a secret is refused with the file and line; one already in
  history opens an issue to rotate it and remove it.
- **Vulnerability alerts.** Dependencies are matched against the OSV
  database. Every alert links to the issue and pull request fixing it.
- **Code scanning.** A reviewer agent reads each pull request's diff for
  security problems and leaves findings as review comments with a
  suggested fix. Findings on `main` open issues.
- **A security page per repository** lists alerts, secrets and findings,
  with the agent work on each, like GitHub's Security tab.

All of these are event sources for the existing issue → agent → checks →
queue pipeline; they need no new kind of work.

### The security suite (built 2026-10-07)

GitHub Advanced Security's depth, in g1t's shape (services/security,
`g1t_contracts::security_suite`, docs `guides/security/*`):

- **Secret protection.** Custom patterns (repository and workspace; Rust
  `regex`, linear time, size-limited; test strings; dry run over the
  default branch) used by push protection, `commit_file` and history
  scans. Bypass with a reason (false positive, used in tests, will fix
  later), recorded on the alert and in the audit log; delegated bypass
  (requests reviewed by owners and repository admins, through the inbox).
  Validity checks for GitHub, GitLab, Stripe, Slack, npm, OpenAI,
  Anthropic and SendGrid tokens, made by the repos service, which reads the
  landed secret again: the value never leaves it except to the issuer. AWS
  keys (need their secret key to sign) and webhook addresses (would post)
  are the extension points left (`g1t_scan::validity::check_for`).
- **Code scanning.** SARIF 2.1.0 uploads → alerts with fingerprints (tool
  partial fingerprints first), fixed when no longer reported; pull request
  uploads → line comments and the `Code scanning` commit status, gated by a
  per-repository threshold and required like any check. Starter workflow:
  a scanner per language present, each uploading its own category: Bandit
  (Python), gosec (Go), ESLint + eslint-plugin-security with the SARIF
  formatter (JS/TS), Clippy + clippy-sarif (Rust); all install from the
  registries the runner's egress already allows. Semgrep's registry rules
  and the Opengrep rules fork are not usable in a paid feature, so neither
  is used. "Fix with g1t" opens an issue and runs the agent.
- **Supply chain.** Dependency graph (direct/transitive where the lockfile
  says, npm licenses), SPDX 2.3 SBOM, `Dependency review` status on every
  pull request (OSV severity threshold, license deny list, summary comment).
- **Overview.** Workspace totals, opened/closed, a daily snapshot trend,
  coverage, repositories most in need first.
- **Paid.** The Security and quality activation on private repositories;
  free on public ones; the free core (secret scanning, push protection,
  vulnerability alerts, security updates, dependency graph) free everywhere.

Not built yet:

- **The reviewer agent as an analysis source.** g1t's reviewer reads each
  pull request's diff (`agent_review`), but its findings are review
  comments, not SARIF. Next: have it emit SARIF for the security issues it
  finds and upload them as the tool `g1t review`, so they become alerts and
  count toward the Code scanning check.
- **Repository security advisories.** Private advisories, draft →
  published, with affected versions (ranges per ecosystem), severity and a
  CVSS vector, credits, and a private fork (a `g1t/advisory/GHSA-…` working
  copy only the advisory's collaborators can see) for the fix, merged into
  the default branch when the advisory publishes. Published advisories
  should feed the OSV-shaped data other g1t repositories' vulnerability
  alerts read. CVE requests are out of scope. Needs: an `advisories` table
  per repository, a collaborator list per advisory, the private-fork
  visibility rule in repos, and an Advisories page on the Security tab.
- **SARIF upload as a background job.** Uploads are read in the request
  (10 MB encoded, 40 MB unzipped, 5,000 results); larger ones need a queue.

### Deployments

- **A preview for every pull request**, at
  `<pr>--<repo>--<owner>.g1t.page`, linked on the pull request and updated
  on each push. `main` deploys to `<repo>--<owner>.g1t.page`, and a
  repository can add its own domain.
- **On g1t.page, not g1t.sh,** so customer code never shares cookies or an
  origin with the site people sign in to.
- **Built on Workers for Platforms.** Each deployment is a user Worker in a
  dispatch namespace; one dispatch Worker on `*.g1t.page` routes to it. The
  build runs in the same runners as Actions. Static sites and Workers apps
  first; container apps and databases later.
- **Agents use the preview.** The reviewer agent opens the preview in a
  browser, takes screenshots of what changed and attaches them to its
  review, so an approver sees the result without reading the diff.
- **Environments.** Preview, production and their secrets; deploy history
  and one-click rollback.
- **Scale to zero.** An idle branch costs neither g1t nor the customer
  anything: a Worker runs, and is billed, only while it answers a request.
  A preview is deleted when its pull request closes or merges, and after
  a set number of idle days. Container apps, later, sleep when idle.
- **Billed to the customer, never free.** The user (2026-10-04): "we
  should not be giving any of this available for free". Every deployment
  is metered per workspace (requests, CPU time, deployed apps, stored
  data), priced at Cloudflare's cost + 20% like agent usage, and drawn
  from prepaid credit. `FREE_WHILE_BUILDING` and the free model allowance
  do not cover deployments: a workspace without credit cannot deploy, and
  turning deployments on says so first.
- **Turning them on is a paid plan, the way Cloudflare's is.** "Including
  things like them even enabling the feature should have that pay like
  Cloudflare does." Enabling deployments for a workspace starts a monthly
  fee that includes an allowance of requests, CPU time and deployed apps;
  usage past it is billed per unit, as Workers for Platforms bills g1t.
  The fee and allowance are the user's to set.
- **Recommended, off in one click.** Because enabling costs money, it is
  never switched on without the workspace agreeing: new repositories
  recommend it prominently. A repository can turn it off, keep only production, or
  deploy somewhere else from its own workflows. Apps built for Cloudflare
  (Workers, static assets, D1, KV, R2) deploy without configuration.

Later, toward GitLab's DevOps breadth: environment protection rules,
package and container registries, releases, container hosting.

## Projects

> **2026-10-04:** the user: "an extra dimension of Projects so it's not
> just repositories … where a lot of things can live", "very Vercel
> like", with dependencies across projects "the Platform Engineering /
> Port route", and "the repository is *part* of a project: you could be
> mirroring it from GitHub/GitLab/Bitbucket, or you could let us host it
> for you", with room for Mercurial or anything else later.

**A project is the thing you are building and running; a repository is
where some of its code lives.** Everything that is about running software
(deployments, environments, domains, secrets, dependencies, owners,
health, upkeep) belongs to the project. What is about the code itself
(branches, pull requests, review, merge rules) stays with the repository.
That split is what lets the code live anywhere.

### The model

| | What it is | Like |
| --- | --- | --- |
| **Workspace** | The company or team. Members, billing, plans, shared secrets. | Vercel team, GitLab group, GitHub org |
| **Group** | An optional named set of projects, one level: "Payments", "Mobile". For browsing, ownership and shared settings. | GitLab subgroup, Backstage system, Port domain |
| **Project** | One deployable thing: a site, an API, a worker, a library. Has exactly one **source**. | Vercel project, Port service, Backstage component |
| **Source** | Where its code is: a repository and a **root directory** in it. | Vercel's connected repo + root directory |
| **Dependency** | Project A uses project B: calls its API, consumes its package, reads its queue. | Port relations, Backstage `dependsOn` |

- **One project, one source; one repository, any number of projects.** A
  project builds from exactly one place, which keeps it as simple as
  Vercel's. A monorepo is several projects on one repository, each with
  its own root directory (`apps/web`, `services/api`), and a push builds
  only the projects whose root it touched. The common case stays 1:1, and
  every existing repository gets a project of its own name when this
  ships, so nobody has to set anything up.
- **Groups are for people; dependencies are for software.** Groups decide
  where a project shows up and who owns it. Dependencies decide what
  happens when one changes. Neither replaces the other, and a dependency
  can cross groups.

### Sources: where the code lives

A source is an adapter behind one interface (`SourcePort`: clone URL,
branches, commits, pushes as events, pull requests if it has them):

| Source | Code lives | g1t gets pushes by | Pull requests |
| --- | --- | --- | --- |
| **Hosted on g1t** (today) | Artifacts | its own events | g1t's, with agents, the queue, review |
| **Mirrored** from GitHub, GitLab or Bitbucket | Both; g1t keeps a copy | the provider's webhook, then fetch | The provider's, read into g1t; agents open theirs there |
| **Connected, not copied** | The provider only | webhook | The provider's |
| **Later:** Mercurial, Perforce, a tarball upload | Behind the same port | per adapter | per adapter |

A mirrored or connected project still gets everything that is the
project's: previews on its pull requests (a status and a comment on
GitHub's), production on its default branch, secrets, dependencies,
upkeep agents. That is the on-ramp: a team keeps GitHub and gets g1t's
deployments and agents first, and moves the code later or never.
Bring-your-own-git is also why the project, not the repository, holds the
URL `g1t.sh/<workspace>/<project>`.

### What lives on a project

| | Today it is on | Moves to the project |
| --- | --- | --- |
| Deployments: production, previews, build settings, root directory, framework | The repository | Yes |
| Environments: production, preview, and custom ones (`staging`) with protection rules (required approvers, branch limits) | Nowhere yet | New, on the project |
| Domains: `<project>--<workspace>.g1t.page`, and custom domains | The repository's name | Yes |
| Secrets and variables | The repository | Yes. Workspace rows link to projects instead of repositories. A repository's workflows read the rows of its project (with several projects on one repository, the one marked as the repository's default). |
| Dependencies | Nowhere | New |
| Owners, on-call, links (docs, dashboards, runbooks) | Nowhere | New: the catalog's metadata |
| Health: scorecards (has an owner, CI passes, dependencies current, no open security alerts, deploys within N days) | Nowhere | New |
| Upkeep agents: dependency updates, security alerts | The plan | Scoped per project |
| Logs and analytics of the running app | Nowhere | New: requests, errors and CPU per environment, from Workers analytics |
| Branches, pull requests, review, merge rules, the queue, webhooks | The repository | Stay |

### Dependencies: why this gets powerful

Declared in the UI, or in the source as `.g1t/project.yml` (which wins
when present, as `catalog-info.yaml` does in Backstage):

```yaml
name: web
root: apps/web
dependsOn:
  - project: api          # calls its HTTP API
    as: API_URL           # its URL, per environment, as a variable
  - project: ui-kit       # consumes its package
```

What g1t does with them:

1. **Reference variables.** `API_URL` above resolves to `api`'s production
   URL in production and to the matching preview in a preview, the way
   Railway's `${{ api.URL }}` references work. No hard-coded URLs.
2. **Preview stacks.** A pull request on `api` gets its own preview, and
   **Preview with dependents** builds `web`'s preview pointed at it, so a
   reviewer clicks through the whole change across projects. A change that
   spans repositories (one issue, one fork per repository) gets one stack.
3. **Release order.** Production deploys go out in dependency order; a
   change set across projects lands through the queue together or not at
   all.
4. **Impact on every pull request.** "Changes `api`; `web` and `mobile`
   depend on it." Agents get the graph in their context: an agent
   changing an API opens follow-up issues on the projects that call it,
   and reviewers see what else could break.
5. **Upkeep across the graph.** A vulnerable package in `ui-kit` opens
   issues, assigned to agents, on every project that consumes it.
6. **Scorecards turn into work.** A project failing a scorecard check
   ("no owner", "dependencies 90 days old") gets an issue an agent can fix.
   That is the Port idea with the work done for you.
7. **The map.** A workspace's projects as a graph, coloured by health and
   by what is deploying now.

### Pages

- `g1t.sh/<workspace>`: projects first (grouped, with health and
  production status), then repositories.
- `g1t.sh/<workspace>/<project>`: overview (production, latest previews,
  health, owners, dependencies both ways), **Deployments**,
  **Environments**, **Secrets and variables**, **Logs**, **Settings**
  (source, root directory, build, domains, groups, owners).
- A hosted repository keeps its code pages; from a project they are its
  **Code** tab. A repository page lists the projects built from it.

### Services

- `services/projects` (new): projects, groups, sources, dependencies,
  owners, scorecards. Events `project.created`, `project.updated`,
  `dependency.changed`.
- `services/deployments`: keyed by project instead of repository.
- Secrets and variables: the scope becomes workspace → project.
- Sources: the hosted adapter wraps `services/repos`; a mirror adapter
  per provider in `services/integrations`, which already holds those
  connections.

### Build order

1. **Projects as the home of deployments and secrets**, 1:1 with every
   existing repository: the service, the pages, deployments and secrets
   moved to the project, `<project>--<workspace>.g1t.page`.
2. **Dependencies:** declared in the UI and `.g1t/project.yml`, reference
   variables, impact on pull requests and in agents' context, the map.
3. **Preview stacks** and cross-project change sets.
4. **Monorepos:** several projects on one repository, each with a root
   directory, building only what a push touched.
5. **Mirrored sources:** GitHub first, then GitLab and Bitbucket.
6. **Groups, owners, scorecards** feeding the upkeep agents.
7. **Environments** with protection rules; custom domains; logs.

**Step 1 shipped 2026-10-04:** `services/projects`; every repository a
project of its own name; the site projects-first (workspace page of
project cards, the project overview at `g1t.sh/<workspace>/<project>`, code
under `/code`, the sidebar and the New project flow); deployments keyed by
project and branch at `<project>-<workspace>.g1t.page` and
`<project>-git-<branch>-<workspace>.g1t.page`; secrets and variables owned
by the project.

**Step 5, GitHub, built 2026-10-05:** one GitHub App (`g1t-sh`) for both
sign-in and repository access. Sign-in is its user authorization with PKCE
(identity, `src/github.rs`): accounts known by GitHub's numeric id, a
matching verified email never linked without signing in to the account,
new accounts behind the invite check. Repositories come through its
installations (integrations, `src/github.rs`), copied with every branch and
tag by the repos service (`src/mirror.rs`) as **import**, **mirror** (g1t
follows GitHub on its push webhook) or **move to g1t** (GitHub follows g1t
on `git.push`). A mirror is a hosted repository that keeps a full copy, so
its project stays `hosted` and deploys like any other; the tie lives in
integrations' `github_repos`. Not yet: previews and statuses on GitHub's own
pull requests, comments and pull requests copied, GitLab and Bitbucket.

### People and search

> **2026-10-04:** "pull up user profiles, using a /u/username prefix kinda
> like DockerHub … search for users if you search that explicitly, how
> GitHub has the aside for searching against filters … a significantly
> stronger implementation."

- **Profiles at `g1t.sh/u/<username>`**, apart from workspaces at
  `g1t.sh/<workspace>`: who they are, their workspaces, recent work,
  agents' sessions they steered.
- **Search with a filter sidebar:** Projects, Code, Issues, Pull requests,
  Users, Workspaces, each with its count; filters by workspace, language,
  state, author, agent, label, date; qualifiers in the query
  (`user:`, `is:open`, `agent:g1t`) as on GitHub. Typing `u/name`
  searches people directly, as Docker Hub does.

1 and 2 serve the competition directly (multi-agent coordination across
projects is 25% of the score); 3 is the demo's best moment if time allows.

## Billing model

> **2026-10-04:** "Some things just require you to have a card on file …
> some things will be something you give us an initial amount of money
> per month just to activate, tons of things additionally will be usage
> based, some things will just be usage based only … at minimum a
> breakeven with Cloudflare costs, or in some cases a value add." Stripe
> moves to Flagon, Inc. (g1t.sh is its product). Proposed below; the
> prices are the user's to confirm.

### Four kinds of charge

Every feature is exactly one of these, and the Billing page says which:

| Kind | What the workspace does | Example |
| --- | --- | --- |
| **Free** | Nothing | Hosting code, issues, pull requests, review, the merge queue, bringing your own agent over MCP |
| **Card on file** | Adds a card; pays only for what it uses | Previews, g1t's agents, workflow minutes |
| **Activation** | Turns a feature on for a monthly fee that includes an allowance; usage past it is metered | Production deployments, Security and quality |
| **Usage only** | Nothing up front; every unit is metered | Model tokens, build minutes, storage past the free amount |

A card is needed before anything that can cost money starts. Nothing is
ever switched on without the workspace choosing it.

### Postpaid, with spend limits

- **One Stripe customer and one subscription per workspace**, on Flagon,
  Inc.'s account. Activations are licensed line items; every usage
  dimension is a metered price backed by a Stripe Meter. Stripe invoices
  monthly in arrears and charges the card on file; failed payments go
  through Stripe's retries and emails, and g1t hears of them by webhook.
- **Spend limits instead of prepaid credit.** A workspace sets a monthly
  limit overall and per feature (Vercel's spend management). g1t counts
  usage as it happens and stops starting new paid work at the limit,
  with a warning at 50%, 80% and 100%. Prepaid top-ups go away; promotions
  (the free model allowance) become Stripe credit on the customer.
- **Usage reaches Stripe from billing alone.** Every service reports
  usage to the billing service as it happens (it already records agent
  runs and builds); billing batches them into Stripe meter events every
  few minutes, idempotently by g1t's own ids, and keeps the ledger g1t's
  pages show. Nothing else talks to Stripe.

### Scope: workspace, then projects

- A feature is turned on for the **workspace** (by an owner, with the
  activation if it has one), then allowed for **all projects** or
  **selected projects**.
- Every **project** can opt out on its own page. A project with nothing
  to deploy (no Workers config, no build script, no `index.html`) is
  detected, says so on its Deployments page, and never builds or costs
  anything.
- Agents and workflows are allowed per project the same way, so a
  workspace can keep spend to the projects that matter.

### Prices: what it costs us, passed through

> **2026-10-04, decided:** postpaid with spend limits, as Vercel and
> Cloudflare do; no per-seat price, ever ("fuck per-seat pricing").
> "If they're barely using them great, but if they're using the shit out
> of them that will cost me a ton, so that cost needs to move onto them."

**Every Cloudflare cost a workspace causes is metered to it.** Light use
fits in a small free allowance; past it, each unit is charged at
Cloudflare's price times a margin of at least 1.5, which pays for Stripe
(about 3%), shared overhead (the site, the API, D1) and g1t itself.

Cloudflare's prices (October 2026), and the cost per unit g1t meters:

| What g1t meters | Cloudflare's price | Cost to g1t per unit |
| --- | --- | --- |
| **Sandbox minute** (agents, checks, merge queue, workflow jobs, deploy builds), standard-1: ½ vCPU, 4 GiB, 8 GB | CPU $0.00002 / vCPU-s while busy; memory $0.0000025 / GiB-s and disk $0.00000007 / GB-s while running | ≤ $0.0012 / minute (CPU counted as busy throughout, since g1t cannot see it per sandbox) |
| **App request** (deployments) | Workers for Platforms: $0.30 / million past 20M | $0.30 / million |
| **App CPU** | $0.02 / million CPU-ms past 60M | $0.02 / million ms |
| **App** (a deployed script) | $0.02 / script-month past 1,000 | $0.02 / app-month |
| **Storage** (repositories, artifacts, caches) | Artifacts $0.50 / GB-month (billing starts 2026-10-14); KV $0.50 / GB-month | $0.50 / GB-month |
| **Git operation** (clone, fetch, push) | Artifacts $0.15 / 1,000 past 10,000 | $0.15 / 1,000 |
| **Model tokens** | The provider's price | As charged |
| Container egress, emails, the site's own requests | Small and shared | In the margin |

> **2026-10-06, decided:** no per-feature quotas on the plan. "A paying
> user should be able to push past the Git operations number, they're
> just paying usage on it." One plan, $20 a month per workspace with $10
> of usage included; every meter is charged from the first unit at cost +
> 20% (builds, app requests and CPU, custom domains), drawn from the $10
> first, then up to the spend limit, which is the only thing that stops a
> paying workspace (with abuse protection). Projects, previews and apps
> are not metered (Workers for Platforms' script pool makes them ~free).
> The forge's free amounts are the same for everyone: 1 GB private storage
> and 50,000 git operations a month; past them the plan pays and a free
> workspace is held (pushes stop, git slowed). The table below is the
> earlier proposal; billing's price book and g1t.sh/pricing are current.

What a workspace pays:

| Meter | Free each month | Then | Margin | For comparison |
| --- | --- | --- | --- | --- |
| Sandbox minutes | None (2026-10-05: charged from the first second) | Cost + 20%, by the second | 1.2× | GitHub Actions $0.008 / minute (Linux 2-core); Vercel builds $0.0035 / CPU-minute |
| App requests | 1 million with Deployments | $0.50 / million | 1.7× | Vercel $0.60 / million invocations |
| App CPU | 3 million ms with Deployments | $0.04 / million ms | 2× | Vercel active CPU about $0.036 / million ms |
| Apps | 10 with Deployments | $0.05 / app-month | 2.5× | |
| Storage | 1 GB | $1.00 / GB-month | 2× | GitHub LFS $0.07 / GB, but repositories are free there |
| Git operations | 10,000 | $0.30 / 1,000 | 2× | |
| g1t's models | | Cost + 20% | 1.2× | The provider's own price |
| Your own model provider | | Only its sandbox minutes (the $0.10 run fee was dropped 2026-10-05) | | |
| **Deployments** activation | | $5 / month, with the allowances above | covers Workers for Platforms' $25 / month across workspaces | Vercel Pro $20 per seat |
| **Security and quality** activation (built 2026-10-07: price book meter `security_activation`) | | $10 / month; fixes as agent usage | | GitHub Advanced Security $49 per committer |

A workspace that uses g1t lightly (a few agent runs, a small site)
pays nothing or its activation; a workspace running agents all day pays
for the sandboxes and models those agents use, with g1t's margin on
each. Nothing in a workspace's bill is subsidised by another's.

### Build order

1. Stripe customer per workspace and card on file (Checkout in setup
   mode), webhooks (invoice paid and failed, subscription changes,
   payment method changes), the Billing page rebuilt around the four
   kinds.
2. One subscription per workspace with activations as items; Deployments
   moves onto it.
3. Meters for each usage dimension above, fed from billing's ledger:
   every sandbox reports how long it ran when it stops (agents, checks,
   the queue, workflow jobs and deploy builds alike); deployments report
   requests, CPU and apps; repos report storage and git operations. Spend
   limits and their warnings; prepaid credit retired.
4. Per-workspace allow-lists of projects for each feature, and per-project
   opt-out; "nothing to deploy" detection.
5. Turn off FREE_WHILE_BUILDING when the user says so. **Done 2026-10-05.**

Shipped by 2026-10-05: sandbox seconds for every sandbox; the price book
and its keeper (runs settled to AI Gateway's price every 15 minutes;
Container and Workers costs checked against Cloudflare's billable usage
and container analytics daily, with a public change log on
g1t.sh/pricing); usage limits by trust with automatic payment near the
limit; app traffic counted toward limits as it happens; billing accounts,
terms and enterprises; free mode off, syntaqx comped.

Still to build, in order: Stripe card-on-file without a payment (setup
mode) and webhooks; month-end invoices for postpaid usage (and one
invoice per enterprise); the subscription with activations as items;
storage and git-operation meters; limit warnings by email at 50/80/100%;
self-serve enterprise management for enterprise owners.

### Accounts, terms and enterprises

Every workspace is paid for by a billing account: its own (`ws_<slug>`)
or an enterprise's (`ent_…`), which pays for several workspaces with one
limit, one set of terms and, once invoices exist, one bill, as GitHub
Enterprise does. Terms are standard, comped (nothing charged, usage still
recorded at cost, paid features on) or custom (a discount, its own
ceiling, an end date). g1t staff manage them in **sudo.g1t.sh**, a
separate Worker behind Cloudflare Access that also verifies the Access
token itself and allows only listed staff emails; every change is kept
with who made it and why.

### Limits: stop non-payers, never payers

The limit is on usage not yet paid for, counted at cost to g1t or charge,
whichever is more: $3 before any live payment, then twice what has been
paid ($25 to $1,000), or what staff set. A workspace with a card on file
is charged automatically near its limit, which both pays what it owes and
raises the limit, so paying users are never stopped. A declined card
stops work until paid. The owner's own spend limit always means stop.
Test-mode payments never lower exposure or raise trust.

### Tax, card fees and free workspaces (built 2026-10-08)

> **2026-10-08, decided:** Stripe Tax everywhere ("so I don't fuck up on
> taxes"); Stripe's card fee passed to the customer with the 20% markup
> kept; one free workspace per person; no invites on free workspaces.

- **Stripe Tax on every payment.** `automatic_tax` on every Checkout page
  (plan, Security and quality, prepaying, AI credit), every subscription
  and every invoice g1t makes (month close, threshold, enterprise), and a
  tax calculation and transaction for auto-reload's off-session charge.
  Tax code `txcd_10103001` (SaaS, business use), every price
  `tax_behavior=exclusive`. Checkout always collects the billing address
  and tax ID and saves them on the customer. Prices on g1t are shown
  excluding tax. Tax is never revenue: balances and plan payments are
  credited without it, it is kept in `tax_and_fees`, shown as its own
  statement line, and as **Tax collected** on sudo's Costs. Without an
  address g1t does not charge: the owners are asked for one.
- **The card fee** (2.9% + $0.30, grossed up) is its own line on every
  card payment, the plan's and Security's as a monthly item; never on a
  bank transfer or an enterprise's invoice. On by default
  (`cost_settings.card_fee`). Not revenue either. Meters stay at cost +
  20%; models at the provider's price plus the agent rate.
- **One free workspace per person.** Identity asks billing
  (`free_workspaces`) before creating one; a second is refused with the
  way forward. Those who own several from before keep them.
- **A free workspace adds no one**: no members, invites or outside
  collaborators until it starts the plan; its members stay; @g1t never
  counts. Enforced in identity for every path (site, API, MCP).
- Details: docs/BILLING_OPERATIONS.md, *Tax and the card fee*.

### Promo codes (planned)

Staff credits (promotional, goodwill, refund; `services/billing/src/grants.rs`,
docs/BILLING_OPERATIONS.md) are given one workspace at a time. Promo codes
give promotional credit in bulk, on redemption, through the same grants:

- **Codes.** sudo → Credits & refunds → **New code**: the code (or one
  made up), the credit ($ amount), max redemptions, when the code stops
  working, how long each redeemed credit lasts (an expiry, as any grant),
  and a note. Table `promo_codes` (code, amount, max, redeemed, ends_at,
  credit_days, note, created_by, disabled_at) and `promo_redemptions`
  (code, workspace, grant id, by, at), unique on (code, workspace).
- **Redeeming.** An owner types it on the workspace's Billing page
  (`redeem_code`, owners only). One D1 batch checks the code is open, under
  its max and not redeemed by the workspace, counts the redemption and
  makes the grant (`grant_credit`, kind promotional, the code as its note),
  so two redemptions at once never pass the max. Wrong or used-up codes say
  so without telling which codes exist; redemptions are rate-limited per
  owner.
- **Seeing them.** Each code's redemptions, credit given and spent come
  from the grants it made, so margin needs nothing new: spent promo credit
  is already given away, by kind.
- **Not yet built** because it adds an owner-facing form, abuse limits and
  a second sudo form; giving credit by workspace covers launch.

## Agents and models

### Defining an agent

An agent is a file (`.g1t/agents/<name>.md`, or in the workspace library):
instructions, the harness and model to run, the tools and MCP servers it may
use, its sandbox image, permissions and budget. Agents take roles: planner,
implementer, reviewer, conflict resolver, documenter, memory consolidator.
Each role has a default that a repo can replace.

### Where it runs, and on whose model

| Option | How it works | Fits |
| --- | --- | --- |
| Hosted, g1t's model | g1t runs the sandbox and bills usage | Getting started; no keys to manage |
| Hosted, your API key | Same sandbox, your Anthropic, OpenAI or Google key | Teams with existing contracts |
| Hosted, your endpoint | Any OpenAI-compatible URL: Bedrock, Vertex, Azure, a self-hosted model | Private or fine-tuned models |
| Your runner | A g1t runner daemon on your own machines picks up pull requests | Code or models that may not leave your network |
| Your own session | Local Claude Code, Cursor or any MCP client joins through `mcp.g1t.sh` | Individuals; subscription plans |

Decisions behind this:

- **g1t does not build its own agent loop.** It runs existing harnesses
  (Claude Code first, through its headless mode) behind a small runner
  contract: a container image, an entry command, and session events reported
  through the CLI. Other harnesses plug in by meeting the contract.
- **All hosted model traffic goes through Cloudflare AI Gateway.** That gives
  one place for spend tracking, budgets, rate limits, fallback and logs,
  whichever provider or endpoint is behind it.
- **Nobody has to pick a model.** A person assigns work to `g1t`, as
  they would assign an issue to a colleague, and **Auto** routes each job
  to the cheapest model that can do it (see
  [Routing for cost](#routing-for-cost) below). A workspace can pin a tier
  per kind of work instead. Each request is tagged at the gateway with the
  kind of work, the tier, the repository and the pull request, and each
  run says which model ran and why. The gateway's own dynamic routes
  cannot make the choice yet: they work only on its OpenAI-compatible
  endpoint, and the harness speaks Anthropic's.
- **Subscriptions stay local.** A Claude subscription cannot be used by a
  hosted sandbox; it needs an API key. People on subscriptions use their own
  Claude Code session, which is a full participant.
- **The workspace pays.** A workspace buys AI credit by card and each
  agent run deducts the model at the provider's price plus the agent rate
  per million (weighted) tokens; on its own model key, only the agent rate,
  counted from the model proxy and the sandbox's own report. The billing service asks
  nothing of the others: the runner asks it before starting a sandbox and
  is refused when there is no credit, and the sandbox reports what its run
  cost with a token only it holds. Where no card processor is configured
  nothing is charged and agents stay limited to listed accounts.
- **Keys are secrets.** Stored in Cloudflare Secrets Store, injected into the
  sandbox for one pull request, never shown again.

### Seeing a pull request through

Assigning an issue is the only thing a person does until there is something
to merge. A pull request made by g1t goes through checks, a review
by another agent, revision when either finds something, and catching up
when `main` moves, without anyone pressing a button. It ends as ready to
merge, or as "needs you" with the reason: the checks still fail after two
revisions, a review could not be written, or a conflict could not be
resolved.

The work service decides the next step from the pull request's state and
claims it in one statement, so a step is taken once. The runner asks on
every event that could change the answer (ready, pushed, checks finished,
review finished, `main` moved), and on a five-minute sweep for anything
missed, and carries the step out in a sandbox.

A pull request does not have to be up to date with `main` to merge,
unless the repository's settings require it, as on GitHub. Merging one that
is behind brings it up to date first (a clean merge needs no model; an
agent resolves a conflict) and lands it when that push arrives. With the
requirement on, catching up is a step of its own and the checks run again
on the result.

Each repository sets its own rules, on one settings page: whether its
default branch takes pushes at all, how many approvals a merge needs and
whether an agent's counts, whether failed checks can be overridden, whether
a second agent reviews, and how often an agent is sent back before a person
is asked. A pull request g1t opens follows the same rules as anyone's.
Pushes to a protected branch are refused in the git front end, with the
reason shown by git beside the branch.

Merging is a person's decision unless the repository says otherwise. With
"merge automatically when ready" turned on in its settings, a ready pull
request lands by itself, attributed to `g1t`. That is the whole path from
an assigned issue to a commit on `main` with nobody in between. Required
human approval per path, and risk tiers, are still to come.

### Routing for cost

*Built (runner `route` in `services/runner/src/model-env.ts`).* The goal
is cost per merged change, not cost per request: a cheap attempt that
fails and is retried on the same model costs more than one that finishes.

- **Tiers and catalogue.** `small` (Claude Haiku 5.5 since 2026-10-08,
  $0.10/$0.50 per million input/output up to 100k-token prompts, five
  times that above; it was Haiku 4.5 at $1/$5), `large` (Claude Sonnet 5.5, $2/$10) and `frontier`
  (Claude Opus 5.5, $4/$20). Models, names and list prices are data,
  never code: since 2026-10-08 billing's model catalogue
  (`gateway_models`, one row per model g1t can use) and staff's defaults
  in sudo, **Agents & models** (`model_defaults`: each tier's model, the
  harness's background model, the AI Gateway's first Claude, each job's
  starting tier and effort), read by the runner once a minute over
  `AGENT_ROUTING`, which is only the fallback when billing cannot be read.
  Catalogue prices are for estimates only; runs are charged what AI
  Gateway priced them at.
- **Keeping up with new models (built 2026-10-08).** The models service
  lists Anthropic's models (through the AI Gateway) and Workers AI's daily
  and on demand; a new id lands in the catalogue as `new`, priced from a
  maintained table of Anthropic's list prices or Workers AI's listing, or
  unpriced, and staff are emailed. Nothing routes to it, offers it or
  charges for it until staff approve it with its prices. A model a provider
  stops listing is `deprecated`; routing never sends work to a deprecated
  or retired model, falling back to the next model of the tier and saying
  so on the run. Customers keep Auto: the catalogue is staff's. See
  [BILLING_OPERATIONS.md](BILLING_OPERATIONS.md#the-model-catalogue).
- **Starting tier by job.** Catch-up, answering a question, and reviews of
  at most 10 files and 200 lines touching no sensitive path: small.
  Plans: small at high effort (Haiku 5.5 takes an effort level).
  Changes, revisions and other reviews: large. Reviews over 60 files
  or 3,000 lines: frontier. Labels: `architecture` frontier, `security` off
  small, `docs`/`documentation`/`typo` let changes and answers start small.
- **Escalation.** A failed (or guardrail-stopped) attempt at the same work
  goes one tier up; two in a row, frontier; a revision counts its rounds;
  a change left at low confidence sends the next attempt up.
- **Learning, per repository.** From the last 20 runs of the same kind:
  one tier down when the cheaper tier finished at least 90% of at least 5
  (never for sensitive or labelled work, never on a retry); one tier up
  when this tier failed at least half of at least 5. No new tables: it
  reads work's `agent_runs` (model, status, confidence).
- **Explained.** Every run's first step and session note is one line:
  *Used a fast model (Claude Haiku 5.5): small change, 3 files and 80
  lines.* Effort per kind of job (`effort` in `AGENT_ROUTING`: plan high,
  answer medium, update low) is sent as `CLAUDE_CODE_EFFORT_LEVEL` on
  g1t's tiers (never on a model the catalogue says takes none) and named
  in that line, with the catalogue's name for the model.
- **Chosen instead.** `model_routes` rows to g1t's models name `small`,
  `large` or `frontier`, or nothing for Auto (Integrations → Models).
  A workspace's own Anthropic key with no model named is routed by Auto
  too.
- **Measured.** `scripts/ops/routing-savings.mjs` replays tasks through
  the router offline, priced from the catalogue, against routing before
  Auto and against the frontier model for everything, net of failed
  attempts, with cost per merged change; `--live` reads billing's runs and
  counted tokens. On the bundled sample (13 tasks, assumed failures): Auto
  costs 7% less than the frontier model for everything and about 7% more
  per run than routing before it, but half as much per merged change,
  because it finishes the hard tasks the old routing gave up on. At
  current prices Opus 5.5 and Sonnet 5.5 cost the same per cache read, and
  cache reads are most of an agent run's tokens, so moving off the
  frontier model saves less than its list price suggests; the fast tier
  and fewer failed attempts are where the money is. Run `--live` monthly
  and after any routing change.
- **A cheaper route for the simplest jobs (designed, off).** A fourth tier
  on Workers AI through AI Gateway (an open model, billed on Cloudflare's
  invoice) for classification-sized jobs: commit messages, triage,
  summaries. Behind the same router as a tier with its own catalogue entry
  and `tasks` rules, off by default. It needs the proxy to translate the
  harness's Anthropic requests to the gateway's OpenAI-compatible
  endpoint (it already does for workspaces' own OpenAI-shaped providers)
  and a quality bar from the savings harness before any job moves to it.

### Choosing the right agent automatically

Because several agents can work on the same issue, every issue with more
than one pull request is an evaluation on real work. g1t records, per repo and per kind of issue, each
agent's win rate, cost and time. That produces a leaderboard, and a routing
policy: send each new issue to the agent that wins that kind most often,
start with the cheapest that is good enough, and escalate to a stronger one
when checks fail.

## Talking: the inbox and channels

Not a discussions forum. People and agents need one place to talk in real
time, and an app that feels like one on desktop and phone.

**The inbox comes first.** Everything that needs a person or that they
follow, from people and agents: review requests, agent questions and
handoffs, failures, mentions, deploys. Read and unread, saved, done,
snoozed; ranked so what an agent is blocked on comes first; email digests
and push. It is the delivery layer chat needs too (who is told what, read
state, push), so building it first makes channels cheap.

*Built:* the events service keeps it (`services/events/src/inbox.rs` and
`subscriptions.rs`, migrations `0005_inbox` and `0006_inbox_threads` on the
`g1t-events` database), writing items as events arrive from the bus; work's
`inbox_subject` says what each event names. Each person has one **thread**
per issue, pull request, workflow on a branch or deployment: new activity
brings it back unread with a count and its last 10 activities, and while it
is unread its most urgent severity is kept. Each item has a **reason**
(`agent`, `review_requested`, `assign`, `mention`, `ci_activity`,
`security_alert`, `state_change`, `author`, `comment`, `manual`,
`subscribed`). Who is told: `agent.asked` and `pull.stalled` (needs you,
closed again by `pull.resumed` and the like), `pull.review_requested`
(needs you, closed by `pull.review_request_removed`),
`issue.assigned`/`pull.assigned`, failed checks and workflows,
`deployment.failed` and a recovering `deployment.succeeded`, g1t's reviews
and finished changes, closes, reopens and merges to everyone subscribed,
and comments to the people mentioned and everyone subscribed. Never the
actor, never g1t. **Subscriptions**: authors, assignees and reviewers are
subscribed without a row; commenting or being mentioned subscribes; anyone
can subscribe, unsubscribe (still told of what is asked of them) or ignore.
**Watching** a repository: participating (the default), all, ignore, or
custom (issues, pulls, deployments, security); whoever creates a repository
watches it at their default, all activity unless they change it.
**Settings**: which reasons are also emailed (agent, review_requested and
mention by default) and the default watch for new repositories; email goes
through identity's `notify_by_email`, to a confirmed address only while the
person can still read the repository. **REST and MCP**: 14 operations under
`/notifications`, `/repos/:owner/:name/subscription` and
`/user/subscriptions` (scopes `notifications:read` and
`notifications:write`, in the Agent preset), and the `notifications` MCP
tool; never usable by g1t's own tokens. On the site: a bell in the top bar
opening a sheet with tabs (All, Needs you, Errors, Success, Info), Done,
Save, Snooze and Mark all read; `/inbox` with Saved, Done and a reason
filter; reasons and update counts on each card; a Notifications box on
issue and pull request pages; a Watch menu in the repository header;
Settings → Notifications; a Needs you card on mission control. Agent sits
beside the bell, disabled. Still to come: security alerts (the security
service publishes no event yet), email digests and push, Agent, and
channels.

**Channels** (working name): workspace channels, direct messages and
threads, live.

- Each channel is a Durable Object holding its WebSocket connections with
  hibernation, so idle channels cost nothing; history in D1, files in R2.
- Agents are members. `@g1t` in a channel starts work, answers, or
  posts a summary; agents post their questions and handoffs where people
  already are. A thread becomes an issue or an outcome in one action, and
  the agent's progress streams into that thread.
- Tied to the work: issues, pull requests, runs and deploys each have a
  thread; links unfurl into live cards (checks, agent step, preview).
  What a channel settles can become workspace memory, with its source.
- Apps: an installable PWA first (desktop and mobile, offline shell, Web
  Push), then native shells on the same API: Tauri for desktop (tray,
  deep links), React Native for iOS and Android (background
  notifications).

GitHub-style Discussions are not planned: channels and threads on the
work replace them.

## What GitHub ships today, and where g1t differs

GitHub's Agent HQ and Copilot app give each agent session its own git
worktree and branch, list sessions in a mission-control view grouped by
project, and let a task be assigned to several agents so their output can be
compared. Underneath, the unit of work is still a branch and a pull request.

| | GitHub | g1t |
| --- | --- | --- |
| Where a session works | A worktree on one developer's machine, or a cloud sandbox | A server-side fork that any agent on any machine can join and anyone can open |
| Agent context | Lives in the app's session view | Stored with the repository and linked from each commit (why-blame) |
| Several agents on one task | Separate pull requests to compare by hand | One issue holding every pull request made for it, compared side by side, with the merged one recorded on the issue |
| Collisions between agents | Found as merge conflicts at the end | Flagged during the work (overlap radar) |
| Landing changes | One pull request at a time | A merge queue that lands the chosen one and closes the rest as superseded |
| Which agents | Those offered through a Copilot subscription | Any MCP client, plus hosted agents |

## How agents connect

1. **Bring your own agent.** A remote MCP server at `mcp.g1t.sh` lets Claude
   Code (or any MCP client) list issues, claim one, get a clone URL and
   token, report progress and submit. Adding it is one command; sign-in is a
   browser OAuth flow with no token to paste. The `g1t` CLI installs Claude
   Code hooks that upload the session transcript as the agent works.
2. **g1t's agent.** Assign an issue to g1t, or many issues at
   once, each to an agent of its own. g1t starts a sandbox for each
   (Cloudflare Containers), running a coding agent headless against its
   own pull request and fork.
3. **API and CLI.** Everything above is available at `api.g1t.sh` and
   through `g1t`.

## Public surfaces

| Host | What it serves |
| --- | --- |
| `g1t.sh` | The site, git over HTTPS, git over SSH |
| `api.g1t.sh` | REST API, with no version in its paths, with a published OpenAPI document, cursor pagination, rate-limit headers, idempotency keys on writes, server-sent events for live pull request state, and signed webhooks |
| `mcp.g1t.sh` | Remote MCP server over streamable HTTP |

g1t is its own OAuth 2.1 authorization server: authorization code with PKCE,
dynamic client registration that stores nothing (a client id encodes its
own registration, so the open endpoint cannot be used to fill a database),
discovery metadata and rotating refresh tokens. Still to come: scopes
per resource (`repo:read`, `repo:write`, `issue:write`, `pull:write`).
MCP clients, the CLI (device flow) and third-party apps all use it. Access
tokens and SSH keys remain for git itself.

### Workspace aliases (internal, built 2026-10-07)

`g1t` is the product; `flagon-io` is Flagon, Inc., the organization that
builds it. So nobody mistakes one for the other, `g1t.sh/g1t` leads to
`g1t.sh/flagon-io`. That is a workspace alias: a name g1t's staff point at
a workspace, kept in identity's `workspace_aliases` (migration 0029, which
seeds `g1t`) by the workspace's id, so it follows renames. It is not a
customer feature and is not documented for users; staff add and remove
aliases on sudo's Aliases page, with a reason, in sudo's audit log. We may
give other companies one for a trading name the same way.

An alias is resolved wherever an old slug is (identity's `resolve_slug`),
so it costs only the not-found path: site pages 301 to the same page under
the workspace, the API and MCP run the call again under its slug, package
registries 301, and git over HTTPS is answered in place
(`resolve_alias`), because pushes do not follow redirects. An alias is
never a route, a username or a workspace's slug, and nobody can register
it while it exists. `@g1t` stays g1t's agent: mentions link to how the
agent works, never to `/g1t`.

## Architecture

| Component | Language | Runs on | Responsibility |
| --- | --- | --- | --- |
| `crates/contracts`, `packages/contracts` | Rust, TypeScript | — | The interface of every service, the event catalogue, shared types. Services and clients depend on this, never on each other's code. |
| `services/identity` | Rust | Worker + D1 | Accounts, workspaces and memberships, sessions, SSH keys, access tokens, device sign-in, OAuth codes and grants |
| `services/repos` | Rust | Worker + D1 + Artifacts | Repository registry, contents, forks, diffs, landing, git over HTTPS. Storage sits behind a `GitStore` port with an Artifacts adapter. |
| `services/work` | Rust | Worker + D1 | Issues, pull requests, comments, sessions; later a Durable Object per repo for the landing queue and live state |
| `services/billing` | Rust | Worker + D1 + Stripe | Each workspace's agent credit: payments, the ledger of every run, and the gate on starting one |
| `services/events` | Rust | Worker + Queues + D1 | The event bus: durable log, and one queue per subscribing service |
| `services/runner`, `crates/runner` | TypeScript, Rust | Worker + Containers | Starts a sandbox per g1t run; the program inside runs the agent harness and reports through the public API |
| `services/og` | TypeScript | Worker + Cache API | Social cards at `og.g1t.sh`: one PNG per page of the site and the docs (satori and resvg), looked up as an anonymous visitor, so nothing private appears on one |
| `apps/web` | TypeScript | Worker | Server-rendered site. Holds no data; calls services over RPC. |
| `apps/docs` | TypeScript | Worker (static) | Documentation and the API explorer |
| `apps/api` | Rust | Worker | REST API (`api.g1t.sh`), MCP server (`mcp.g1t.sh`) and OpenAPI document, all generated from one list of operations; the OAuth endpoints |
| `crates/sshd` | Rust | Container | Git over SSH, bridged to Artifacts |
| `crates/merged` | Rust | Container | Trial merges, conflict matrix, landing merges (needs real git; the Artifacts binding is read-only) |
| `crates/core` | Rust | native and WASM | pkt-line, packfile and diff code shared by the above and by the Worker |
| `crates/g1t` | Rust | user's machine | CLI: auth, SSH proxy, Claude Code hooks, issues and pull requests |

Storage: Artifacts for repositories (one fork per pull request), D1 for accounts
and metadata, R2 for session transcripts and logs, Durable Object SQLite for
per-repo coordination state.

How the services fit together:

- **Each service is its own Worker with its own database.** It deploys,
  scales and fails on its own. Callers reach it through a typed RPC binding
  to the interface in `packages/contracts`.
- **Expected failures are values.** Every call returns a `Result`, so "not
  found" or "forbidden" crosses a service boundary as data.
- **Side effects travel as events.** A service publishes what happened
  (`git.push`, `issue.opened`, `pull.merged`, …) to the bus and does not
  call other services to react. Each subscriber consumes from its own queue.
  Timelines, webhooks and automations read the same stream, which is what
  lets something like GitHub Actions be built on top.
- **Every read takes the viewer.** Authorization is decided inside the
  service that owns the data, not by its callers.

The Workers runtime scales request handling on its own, so the edge layer
stays in TypeScript. Rust is used where there is real computation or a real
protocol to implement.

## Languages

The site is TypeScript. Everything behind it is Rust, compiled to
WebAssembly for Workers and natively for containers and the CLI. Identity, repos, work, events and the API are all Rust. The one exception
is the Worker that starts sandboxes, because Cloudflare's Containers
library is TypeScript. Rust services speak a
small JSON protocol over service bindings (`POST /rpc/<method>`), with the
types in `crates/contracts`.

## Identifiers

Every id is a [TypeID](https://github.com/jetify-com/typeid): a prefix naming
the kind of thing, then a UUIDv7 in lowercase base32, such as
`pr_01jb2k7x9hfq0b3zj0f5s2m8ra`.

- The prefix makes an id self-describing and stops ids of different kinds
  being mixed up.
- Ids sort by creation time as plain strings. In SQLite (D1 and Durable
  Objects) that keeps inserts at the end of the primary-key index instead of
  scattering them, and gives time-ordered paging for free.
- The suffix decodes to a standard UUIDv7 for any system that wants one.
- Ids are made by the service that creates the record, not by the database,
  so they work across services and can be assigned before a write.

## Events at scale, and audit

The current event log is a single D1 database. That is fine for a
prototype and wrong for the target: D1 is one writer and 10 GB. The design
for volume splits storage by how the data is read.

| Tier | Store | Holds | Read by |
| --- | --- | --- | --- |
| Hot | A Durable Object per repository, with SQLite | Recent events for that repo | Timelines, live pages over WebSocket |
| Complete | Cloudflare Pipelines into R2 as Apache Iceberg | Every event, forever, partitioned by day and workspace | Analytics, standups, "ask", export |
| Audit | The same R2 store, under object lock | Who did what, from where, with which credential | Compliance, investigation |

- **No single hot database.** Each repository's recent events live with that
  repository, so load spreads across as many objects as there are repos.
- **The complete record is files, not rows.** Iceberg on R2 has no practical
  size limit and is queried with SQL.
- **Audit is a property of every event.** The envelope carries the actor
  (person, agent, token or system), the credential used, the request id and
  the source address. Audit entries for a workspace are hash-chained, so a
  removed or altered entry is detectable, and are written under a retention
  lock.
- **Delivery is at least once.** Consumers are idempotent on the event id.

## Accounts and forge basics

- Registration with email verification, sign-in, forgot password (Cloudflare
  Email Sending), Turnstile on public forms.
- GitHub sign-in, SSH keys, access tokens, active sessions.
- Profiles, public and private repositories, repository search (D1 full-text).
- Rendered README, syntax highlighting, commit history, diffs.
- Transferring a repository between workspaces (by id: its git store key
  never moves; every service follows `repo.transferred`; old paths redirect
  until reused) and deleting an empty, settled workspace (its slug is
  tombstoned, never reissued except to the person whose username it is).
- Access: five repository roles (Read, Triage, Write, Maintain, Admin;
  the capability table follows GitHub's repository roles, 2026-10-08:
  branch protection and rulesets are Admin, labels and milestones are made
  with Write and applied with Triage, security alerts are Write), a
  workspace base permission (Read for new workspaces), the creator of a
  repository given Admin on it, outside collaborators and invitations.
  Membership as GitHub's organizations have it (2026-10-08): owners and
  members, promote and demote, transfer ownership, leave, a last-owner
  guard; billing manager and security manager on top of member; member
  privileges (who creates public and private repositories, whether
  repository admins change visibility, delete and transfer, and invite
  outside collaborators); two-factor authentication (TOTP and recovery
  codes) and a workspace policy that requires it, holding non-compliant
  people out until they turn it on. Every membership change, token, SSH
  key, OAuth grant and two-factor change is in the audit log. Teams are built on it (2026-10-07): visible
  or secret, nested up to 8 levels (child teams inherit their parents'
  roles), run by maintainers and owners. A team's role on a repository is a
  `repo_grants` row whose principal is the team, which identity resolves
  into the same `RepoGrant`s on each person, so `access::can` needs nothing
  new: the highest role wins. `@workspace/team` mentions tell the team's
  people; a team asked to review either asks everyone or picks people by
  round robin or load balance.
- CODEOWNERS, read in both conventions (single-section, and sections with
  approval counts, optional sections and default owners) from the first of
  `.g1t/`, `.github/`, the root, `docs/` and `.gitlab/`. Owners are asked to
  review, the `g1t / codeowners` status lints a changed file, and branch
  protection's "Require review from code owners" holds merges, for people,
  agents and the queue alike, until each owning rule is approved.

## Built on Cloudflare

| Need | Product |
| --- | --- |
| Repositories; a fork per pull request; data residency per workspace | Artifacts (forks, jurisdictions) |
| Reacting to pushes | Artifacts event subscriptions on Queues |
| Preview URL per pull request; deploy on merge | Workers for Platforms on `g1t.page` |
| Site, API, MCP, git front end | Workers |
| Per-repo coordination, live updates | Durable Objects |
| Pull request lifecycles, automations | Workflows, Cron Triggers |
| Agent sandboxes, SSH server, merge engine | Sandbox SDK and Containers |
| Fast starts on large repos | ArtifactFS |
| Model traffic, spend, budgets | AI Gateway |
| Summaries, embeddings | Workers AI |
| Context hub search | Vectorize |
| Accounts and metadata | D1 |
| Transcripts and logs | R2 |
| Email, bot protection, keys | Email Sending, Turnstile, Secrets Store |

## Running g1t yourself

g1t.sh runs on Cloudflare, and that does not change. The core is MIT and
must also run on anyone's own machine with `docker compose up`. A free
core people can self-host is what makes paid hosting worth trusting.
Self-hosting never makes hosted worse: hosted code paths keep their
behaviour, and a self-hosted adapter sits beside the hosted one. The
inventory of every Cloudflare dependency, the design and the risks are in
[SELF_HOSTING.md](SELF_HOSTING.md).

The approach: the Workers stay Workers, and self-hosted they run in
workerd, the open-source Workers runtime. D1, KV and Queues are SQLite on a
volume, with the same migrations. Cloudflare-only bindings are replaced
by stand-ins:

- Artifacts becomes bare repositories served by `git http-backend`;
- Email Sending becomes SMTP, through Mailpit;
- services that are off answer "off" instead of failing.

| Phase | Scope | Estimate |
| --- | --- | --- |
| 1. Core forge | Done: `deploy/self-host/` (compose, git store, binding stand-ins, smoke test) and the "Run g1t yourself" guide. Left: the API on its own port, `PUBLIC_URL` in place of hard-coded hosts, cron, pull requests in the smoke test, CI that runs it. | 1–1.5 weeks left |
| 2. Agents | Docker sandboxes with the same runner image, an egress allow-list proxy for guardrails, `g1t.toml`, a launcher in place of `wrangler dev` | 2–3 weeks |
| 3. Search, context, deployments | sqlite-vec plus an OpenAI-compatible embedder; an app host on workerd; Caddy for app and custom domains; SSH | 3–4 weeks |
| 4. Parity and upgrades | Code-level ports in `g1t_kit` and `@g1t/platform`, sudo without Access, online backups, released images, an upgrade test in CI | 3–4 weeks |

## The submission

- **g1t is built on g1t.** This repository is hosted on g1t.sh, its features
  are opened as issues and built by racing agents, and it deploys from
  Artifacts through Workers Builds. The history is the proof.
- **The demo follows one story.** A brief becomes a project; twelve issues
  fan out to dozens of agents; agents notice each other, hand off, and
  resolve a conflict; reviewers triage; the queue lands everything on
  `main`; why-blame explains a line; the portfolio shows where it all
  stands. Then the same thing at a thousand agents.
- **Judges can try it in a minute.** Open registration on g1t.sh, one-click
  import of a GitHub repo, one command to connect Claude Code, a seeded demo
  workspace, and a single deploy command for running their own copy.
- **The formats are open.** The commit trailers, session format and runner
  contract are published so other tools can interoperate.

## Build order

What is left is ordered by how much it shows the point above, not by forge
parity. Forge basics are done well enough; each item below should make the
demo's story stronger.

Done from this list: the outcome page (a plan's issues as a live graph with
cost and a feed of what happened), coordination you can see (agents' issues
and comments stand out in the feed; agents hold g1t's tools through a token
scoped to one repository), steering a running agent (messages delivered
between steps, and at the end), and recording sessions from anyone's own
Claude Code (`curl -fsSL https://g1t.sh/install/claude.sh | sh`). Integrations are
in: a workspace's own model provider (Anthropic or any Anthropic-compatible
endpoint, reached through a model proxy so no sandbox holds a key; its
runs pay only their sandbox time), alerts from Sentry, Datadog and signed webhooks
that open one issue per problem and can start an agent, and Jira and Linear
tickets that agents read, people import, and that hear back. Racing a
set number of agents on one issue is dropped: choosing how many agents to
use is not something people should have to do.

1. ~~**Handoffs and questions between agents** as states on the outcome
   page.~~ Done: questions and handoffs show as waiting, read, answered,
   taken on or declined; since 2026-10-03 an agent asked while it is not at
   work is woken to answer, where before the question waited forever.
2. **Upkeep agents** (above): dependency updates, secret scanning,
   vulnerability alerts, code scanning, the security page. No new
   infrastructure.
3. **Deployments on `g1t.page`** (above): previews per pull request,
   production on merge, the reviewer agent checking the preview.
4. **The large run, building 2 and 3.** About 20–30 issues on g1t itself,
   built by agents and landed through the queue, for the video: g1t built
   on g1t.
5. **Polish for judges trying it in a minute:** a seeded demo workspace, the
   empty states, and the first-run path from sign-up to an outcome landing.

Earlier items still open, after those:

1. Deleting a branch once its pull request merges; risk tiers. (Approval
   rules per path are in, as CODEOWNERS.)
2. Event storage per the design above: per-repo hot log, Iceberg on R2,
   hash-chained audit.
3. CLI with Claude Code hooks to record sessions automatically.
4. Reviewing and catching up automatically, by policy; required reviews;
   risk tiers.
5. Compare view, proof bundles; handoff between agents.
6. Projects, mission control, steering; why-blame, digest, timeline.
7. Context hub, portfolio; automations and integrations (Sentry first).
8. SSH; bot protection; own keys, endpoints and runners.
9. Large run (100+ agents across many issues), hardening, demo.
10. Passkeys (WebAuthn) as a second factor and for signing in: feasible on
    Workers (P-256 and RS256 verification in Rust, or WebCrypto), next
    after TOTP. Then fine-grained tokens, deploy keys and package access.

Later: code search, mirroring to GitHub, SSH
on port 22 without the CLI proxy (needs the Workers inbound TCP private
beta).
