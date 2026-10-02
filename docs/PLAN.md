# g1t plan

g1t is a git forge for agents, built on Cloudflare Workers and Artifacts for
the "Build the Next-Gen Git Platform on Cloudflare" competition.

- Submission closes **October 14, 2026, 11:59 PM PDT**: a 5–10 minute demo
  video, this repository (MIT) and run instructions.
- Judging: 50% originality and quality of the prototype for agent-oriented
  collaboration; 25% multi-agent concurrency, coordination, context
  preservation, review and conflict handling; 25% ease of use.

## Product model

A pull request assumes one author and one change. g1t assumes many agents
working at once, in two shapes: several agents racing on the same goal, and
many different goals in flight that all have to land on `main`.

| Concept | What it is |
| --- | --- |
| **Intent** | A goal stated against a repo, with acceptance checks (commands that must pass). Replaces the issue and the pull request. |
| **Attempt** | One agent's run at an intent, in its own Artifacts fork. Any number run in parallel. |
| **Session** | The agent's full context for an attempt: prompt, messages, tool calls, cost. Stored with the attempt and linked from every commit it produced. |
| **Arena** | The compare view for an intent: every attempt side by side with diff, check results, conflicts against main and against each other, and a reviewer agent's summary. |
| **Ship** | A person or a policy picks an attempt. A per-repo merge queue lands it; the other attempts are rebased by their agents or closed. |

Features that fall out of the model:

- **Why-blame.** Click a line and see the prompt and reasoning that produced
  it, not only the commit.
- **Overlap radar.** Attempts that touch the same files are flagged while the
  agents are still working, and the agents are told.
- **Live lanes.** Watch every attempt progress in real time.

## Converging on main

Twelve intents started together will finish at different times and touch
overlapping code. Getting them all into `main` without a person refereeing
is the hard part, and it is handled in four places.

1. **Before work starts: plan the overlap away.** A project is a graph of
   intents. A planner agent can split a large goal into intents, predict
   which files each will touch, and add a dependency where two would collide,
   so one starts from the other's result instead of from `main`.
2. **While agents work: overlap radar.** Each attempt's changed files and
   symbols are tracked as it pushes. When two attempts from different intents
   enter the same area, both agents are told what the other is doing there.
3. **When `main` moves: the author resolves.** Every open attempt is
   trial-merged against the new `main`. A clean merge updates the attempt
   silently. A conflict resumes that attempt's agent with its original
   session and the incoming change, so the conflict is resolved by the agent
   that wrote the code and still knows why.
4. **At landing: a speculative queue.** Shipped attempts enter the repo's
   queue. g1t builds the combined states (`main`+A, `main`+A+B, …) and runs
   their checks in parallel. Attempts land in order as their combined state
   passes; one that fails is ejected back to its agent and the states behind
   it are rebuilt. `main` only ever receives a state that passed.

Landing can be fully automatic: a repo policy such as "checks pass and the
reviewer agent approves" ships without a person.

## Agents aware of each other

Each repo keeps a live **work registry**: for every running attempt, its
intent, a running summary of what it has done, and the files and symbols it
has touched or plans to touch. Agents use it through MCP tools; g1t also
acts on it without being asked.

- **Before starting.** When an intent is opened, or an agent is about to
  begin a task, g1t searches open intents and running attempts for the same
  goal (by meaning, not wording) and for the same area of code. If a match
  exists the agent is told who is on it and how far along, and chooses: join
  as a deliberate racer, wait for the result, or drop the task. Duplicate
  intents are offered for merging.
- **Finding out-of-scope work.** An agent that discovers something outside
  its intent asks the registry who works there. If another attempt owns that
  area, it **hands off**: a note, the relevant excerpt of its session, and
  optionally commits the receiver can take. If nobody does, it opens a child
  intent instead of widening its own change.
- **Asking.** An agent can put a question or a request to another attempt.
  The receiver gets it at its next turn.
- **Waiting.** An agent that needs another attempt's result parks itself.
  Its sandbox sleeps, spend stops, and it resumes from the new state when
  that attempt ships.
- **Agents that do not cooperate.** For pushes from tools that never call
  these tools, g1t compares the pushed change against running attempts and
  flags near-duplicates itself.

Every handoff, question and wait has a state (offered, accepted, declined,
done), appears in the timeline, and is visible to people. A handoff declined
twice, or two agents passing work back and forth, goes to the "needs you"
inbox.

## Review at scale

Cloudflare's brief asks "how do you review everything they produce?". With
hundreds of agents, a person cannot read every diff, so review is by
exception.

- **Evidence, not diffs.** Every attempt carries a proof bundle: checks run
  and their output, a preview URL, a plain-language summary, and the
  behaviour that changed.
- **Two agent reviewers.** One reviews the change against the intent. A
  second is adversarial: it tries to break the change and reports what it
  found.
- **Risk tiers.** Each change is scored from what it touches, how large it
  is, and how the reviewers ruled. Low risk ships on policy; high risk goes
  to a person with the evidence already assembled.
- **Trust is earned.** An agent's record on a path (shipped, reverted, caught
  by review) raises or lowers the tier its changes land in.
- **Sampling.** A share of auto-shipped changes is sent to a person anyway,
  to keep the policy honest.

## Rethinking the git primitives

- **No branches for agents.** An attempt is a fork; `main` is the only
  long-lived line. There is nothing to name, clean up or go stale.
- **Projected main.** New attempts start from `main` plus everything already
  in the landing queue, so they are built on the state they will land on.
- **Structural merge.** The merge engine merges by syntax tree, not by line,
  for supported languages. Two agents adding different functions to the same
  file do not conflict.
- **Forkable sessions.** A session can be forked at any turn: the code as it
  was at that moment plus the conversation up to it, continued with a
  different instruction. Branching applies to the reasoning as well as the
  code.
- **Provenance in history.** Every commit records its intent, session,
  agent, model and cost, and is signed with a key issued to that attempt. The
  history can be audited by machine.

## People in the loop

### Code that arrives from outside

People will keep pushing with plain git, their editor, or another tool. Every
push goes through g1t's git front end, so none of it bypasses the model.

- **A push to a branch becomes an attempt.** g1t adopts it with the pusher as
  author. A reviewer agent writes the intent it appears to serve and offers
  to attach it to an open intent it matches. From there it gets the same
  checks, arena and queue as agent work.
- **A push to `main` follows repo policy.** Protected: refused with a message
  saying which ref to push to instead, so it enters the queue. Open: accepted
  and treated as "`main` moved", which re-verifies the queue and triggers
  resolve-on-move for every open attempt.
- **Context is an open format.** A commit trailer names the session that
  produced it, so any tool can attach its transcript. Commits without one are
  shown in why-blame as "pushed by a person, no session".
- **Approval rules.** Per repo and per path: ship automatically, require a
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
- **Take over and hand back.** Check out the attempt's fork, commit by hand,
  push, and let the agent continue from there.

### Planning by writing

- **Brief.** Write the outcome in prose on the site, or commit it as a
  markdown file. A planner agent turns it into a project: intents, acceptance
  checks, dependencies. The person edits the graph before anything starts.
- **Plan from their own agent.** The same operations are MCP tools, so a
  person can plan in their own Claude Code session and create the project
  from there.
- **The brief stays the source of truth.** Editing it later re-plans: new
  intents are added, obsolete ones are closed.

### Seeing what moved

- **Project page.** The outcome, the intent graph coloured by state, and how
  many acceptance checks pass now compared with when the project started.
- **Digest.** An agent-written summary per project and per person: what
  shipped, what is blocked on whom, which conflicts were resolved, what it
  cost.
- **Timeline.** Every event (push, steer, check, conflict, ship) in order,
  each linked to the session and the person or agent behind it.

## One session, any surface

A session belongs to g1t, not to the device it started on. The browser, a
phone and Claude Code are views of the same session.

- **Browser and phone.** The site is a responsive, installable web app with
  push notifications. Everything a person does (brief, steer, answer,
  approve, ship) works there.
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
  attempt and "publish" is ship, without git vocabulary.
- **Document intents.** "Write the onboarding guide for the billing API" is
  an intent. Its acceptance checks are a checklist judged by a reviewer agent
  instead of commands. Agents draft and revise; people comment and approve.
- **Templates.** Product brief, RFC, decision record. A filled-in template is
  a brief the planner can turn into a project.
- **Explain.** Ask about any repo, project or change in plain language and
  get an answer with links to the code and sessions behind it.
- **Living documentation.** g1t generates "how this works" pages from the
  code and keeps them current. When a shipped change contradicts a document,
  an intent opens to update it.
- **See it, don't read it.** Every attempt on a deployable repo gets a
  preview URL (Workers Builds from the attempt's fork), so an approver clicks
  through the result instead of reading a diff. Changes are also summarised
  in plain language.
- **Roles.** Viewer, commenter, planner, approver: a person can plan and
  approve work without ever cloning a repo.

## The macro view

The hierarchy above a single repo:

| Level | What it is |
| --- | --- |
| **Workspace** | A company or team: its people, repos, agents, budget and policies. |
| **Initiative** | A business outcome with an owner and measurable results, e.g. "move billing to usage-based pricing". Spans any number of repos. |
| **Project** | One deliverable inside an initiative: a brief and its graph of intents. |
| **Intent / Attempt** | As above. An intent may touch several repos; its attempt then holds one fork per repo and they land together. |

### Portfolio

One page answers "where is the business" across every initiative:

- **Health** per initiative: on track, at risk, or blocked, derived from
  facts (checks passing, intents stalled, questions waiting on a person),
  not self-reported.
- **Progress** as measurable results: acceptance checks passing, intents
  shipped out of planned, and the trend since the start.
- **Forecast** from actual throughput: at the current rate, when the
  remaining intents land.
- **Spend** in tokens and dollars against a budget, per initiative.
- **Waiting on people**: every decision or approval a person owes, by name.
- **Roadmap**: initiatives laid out as now, next, later, with optional
  time-boxed cycles for teams that work in sprints.

### Status without asking

- **Standup.** An agent writes a daily report per initiative and one for the
  whole workspace: what shipped, what changed direction, what is at risk and
  why, what needs a person. Delivered by email or webhook.
- **Ask.** A question box over the full event log and all sessions: "what
  happened on the billing migration since Monday?" answers with links to the
  sessions and commits behind each claim.

### Long-running agents

Work that runs for days needs supervision that does not depend on someone
watching.

- **Checkpoints.** A long attempt reports milestones against its intent, so
  progress is visible before anything ships.
- **Stall and drift detection.** An attempt with no meaningful progress, or
  whose changes have wandered away from its intent, is flagged and can be
  stopped or re-briefed automatically.
- **Budgets.** Hard limits on spend and time per attempt, project and
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
  remains the source of truth, and a link placed on an intent ("see
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
  intent, found by search, and can query more through MCP.
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
  intent waiting on a decision, and what shipped, across all repos.
- **Projects.** Group intents across repos toward one outcome and track how
  many are open, racing, or shipped.
- **Steering.** Send a message to a running attempt, or to all attempts on an
  intent at once, without stopping them.
- **Automations.** Rules that start work without a person (next section).

## Automations and integrations

An automation is **when** an event happens, **if** conditions hold, **do**
something. They are defined as files in the repo (`.g1t/automations/`), the
way GitHub Actions workflows are, and can also be built in the UI.

### Events that can trigger one

| Source | Examples |
| --- | --- |
| Git | push, ship, check failed, `main` moved |
| g1t | intent opened, attempt stalled, context updated, handoff declined, budget reached |
| Time | cron schedule |
| Integrations | Sentry issue, PagerDuty incident, Linear or Jira ticket, Slack message or mention, GitHub issue, Stripe event |
| Anything else | a signed generic webhook, or an email to a per-repo address |

**Actions**: open an intent (optionally racing N attempts with a named
agent), message a running attempt, update documentation, notify, call a
webhook, write back to the source system.

**Example: Sentry.** A new production error arrives. The automation opens an
intent with the stack trace, release and frequency as its brief. Why-blame
finds the session that wrote the failing line, so the fixing agent starts
with the original reasoning. When the fix ships, g1t comments on the Sentry
issue and resolves it.

### Rules every automation obeys

- **Deduplication.** The same Sentry issue firing 500 times maps to one
  intent.
- **Limits.** Concurrency and budget caps per automation.
- **Loop protection.** Work started by an automation cannot retrigger the
  same automation without a person in between.
- **External input is untrusted.** A webhook payload can contain text written
  by an attacker. Agents started by external events run with reduced
  permissions and cannot ship without the repo's approval rule passing.

**Checks** are the other half of what GitHub Actions does: build and test
commands declared in `.g1t/checks.yaml`, run in sandboxes on every attempt
and on every combined state in the landing queue.

Agents can also reach integrations directly: an agent definition lists MCP
servers (Sentry, Linear and so on) it may use while working.

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
| Your runner | A g1t runner daemon on your own machines picks up attempts | Code or models that may not leave your network |
| Your own session | Local Claude Code, Cursor or any MCP client joins through `mcp.g1t.sh` | Individuals; subscription plans |

Decisions behind this:

- **g1t does not build its own agent loop.** It runs existing harnesses
  (Claude Code first, through its headless mode) behind a small runner
  contract: a container image, an entry command, and session events reported
  through the CLI. Other harnesses plug in by meeting the contract.
- **All hosted model traffic goes through Cloudflare AI Gateway.** That gives
  one place for spend tracking, budgets, rate limits, fallback and logs,
  whichever provider or endpoint is behind it.
- **Subscriptions stay local.** A Claude subscription cannot be used by a
  hosted sandbox; it needs an API key. People on subscriptions use their own
  Claude Code session, which is a full participant.
- **Keys are secrets.** Stored in Cloudflare Secrets Store, injected into the
  sandbox for one attempt, never shown again.

### Choosing the right agent automatically

Because several agents can race on the same intent, every arena is an
evaluation on real work. g1t records, per repo and per kind of intent, each
agent's win rate, cost and time. That produces a leaderboard, and a routing
policy: send each new intent to the agent that wins that kind most often,
start with the cheapest that is good enough, and escalate to a stronger one
when checks fail.

## What GitHub ships today, and where g1t differs

GitHub's Agent HQ and Copilot app give each agent session its own git
worktree and branch, list sessions in a mission-control view grouped by
project, and let a task be assigned to several agents so their output can be
compared. Underneath, the unit of work is still a branch and a pull request.

| | GitHub | g1t |
| --- | --- | --- |
| Where a session works | A worktree on one developer's machine, or a cloud sandbox | A server-side fork that any agent on any machine can join and anyone can open |
| Agent context | Lives in the app's session view | Stored with the repository and linked from each commit (why-blame) |
| Several agents on one task | Separate pull requests to compare by hand | One intent, one arena, ranked attempts |
| Collisions between agents | Found as merge conflicts at the end | Flagged during the work (overlap radar) |
| Landing changes | One pull request at a time | A merge queue that ships the winner and rebases or closes the rest |
| Which agents | Those offered through a Copilot subscription | Any MCP client, plus hosted agents |

## How agents connect

1. **Bring your own agent.** A remote MCP server at `mcp.g1t.sh` lets Claude
   Code (or any MCP client) list intents, claim one, get a clone URL and
   token, report progress and submit. Adding it is one command; sign-in is a
   browser OAuth flow with no token to paste. The `g1t` CLI installs Claude
   Code hooks that upload the session transcript as the agent works.
2. **Hosted agents.** Press "Run 10 attempts" on an intent. g1t starts
   sandboxes (Cloudflare Sandbox SDK), each running a coding agent headless
   against its own fork.
3. **API and CLI.** Everything above is available at `api.g1t.sh` and
   through `g1t`.

## Public surfaces

| Host | What it serves |
| --- | --- |
| `g1t.sh` | The site, git over HTTPS, git over SSH |
| `api.g1t.sh` | Versioned REST API with a published OpenAPI document, cursor pagination, rate-limit headers, idempotency keys on writes, server-sent events for live attempt state, and signed webhooks |
| `mcp.g1t.sh` | Remote MCP server over streamable HTTP |

g1t is its own OAuth 2.1 authorization server: authorization code with PKCE,
dynamic client registration, discovery metadata, refresh tokens, and scopes
per resource (`repo:read`, `repo:write`, `intent:write`, `attempt:write`).
MCP clients, the CLI (device flow) and third-party apps all use it. Access
tokens and SSH keys remain for git itself.

## Architecture

| Component | Language | Runs on | Responsibility |
| --- | --- | --- | --- |
| `packages/contracts` | TypeScript | — | The interface of every service, the event catalogue, shared types. Services and clients depend on this, never on each other's code. |
| `services/identity` | TypeScript | Worker + D1 | Accounts, sessions, SSH keys, access tokens; later the OAuth server |
| `services/repos` | TypeScript | Worker + D1 + Artifacts | Repository registry, contents, forks, git over HTTPS. Storage sits behind a `GitStore` port with an Artifacts adapter. |
| `services/events` | TypeScript | Worker + Queues + D1 | The event bus: durable log, and one queue per subscribing service |
| `services/work` | TypeScript | Worker + D1 | Intents, attempts, sessions; later a Durable Object per repo for the landing queue and live state |
| `apps/web` | TypeScript | Worker | Server-rendered site. Holds no data; calls services over RPC. |
| `apps/api` (next) | TypeScript | Worker | REST API (`api.g1t.sh`) and MCP server (`mcp.g1t.sh`) over the same services |
| `crates/sshd` | Rust | Container | Git over SSH, bridged to Artifacts |
| `crates/merged` | Rust | Container | Trial merges, conflict matrix, landing merges (needs real git; the Artifacts binding is read-only) |
| `crates/core` | Rust | native and WASM | pkt-line, packfile and diff code shared by the above and by the Worker |
| `crates/g1t` | Rust | user's machine | CLI: auth, SSH proxy, Claude Code hooks, intents and attempts |
| runner image | — | Sandbox | Hosted agent environment |

Storage: Artifacts for repositories (one fork per attempt), D1 for accounts
and metadata, R2 for session transcripts and logs, Durable Object SQLite for
per-repo coordination state.

How the services fit together:

- **Each service is its own Worker with its own database.** It deploys,
  scales and fails on its own. Callers reach it through a typed RPC binding
  to the interface in `packages/contracts`.
- **Expected failures are values.** Every call returns a `Result`, so "not
  found" or "forbidden" crosses a service boundary as data.
- **Side effects travel as events.** A service publishes what happened
  (`git.push`, `intent.opened`, `attempt.started`, …) to the bus and does not
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
WebAssembly for Workers and natively for containers and the CLI. Services
are being ported one at a time; identity is done. Rust services speak a
small JSON protocol over service bindings (`POST /rpc/<method>`), with the
types in `crates/contracts`.

## Identifiers

Every id is a [TypeID](https://github.com/jetify-com/typeid): a prefix naming
the kind of thing, then a UUIDv7 in lowercase base32, such as
`att_01jb2k7x9hfq0b3zj0f5s2m8ra`.

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

## Built on Cloudflare

| Need | Product |
| --- | --- |
| Repositories; a fork per attempt; data residency per workspace | Artifacts (forks, jurisdictions) |
| Reacting to pushes | Artifacts event subscriptions on Queues |
| Preview URL per attempt; deploy on ship | Workers Builds and previews |
| Site, API, MCP, git front end | Workers |
| Per-repo coordination, live updates | Durable Objects |
| Attempt lifecycles, automations | Workflows, Cron Triggers |
| Agent sandboxes, SSH server, merge engine | Sandbox SDK and Containers |
| Fast starts on large repos | ArtifactFS |
| Model traffic, spend, budgets | AI Gateway |
| Summaries, embeddings | Workers AI |
| Context hub search | Vectorize |
| Accounts and metadata | D1 |
| Transcripts and logs | R2 |
| Email, bot protection, keys | Email Sending, Turnstile, Secrets Store |

## The submission

- **g1t is built on g1t.** This repository is hosted on g1t.sh, its features
  are opened as intents and built by racing agents, and it deploys from
  Artifacts through Workers Builds. The history is the proof.
- **The demo follows one story.** A brief becomes a project; twelve intents
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

Done: site on g1t.sh; git over HTTPS; accounts and private repos; the four
services and the event bus; intents, attempts (a fork each) and session
storage, with pages for each. SSH server written, not deployed.

1. `api.g1t.sh` and `mcp.g1t.sh`; CLI with Claude Code hooks, so an outside
   agent can claim an intent, push, and record its session.
2. OAuth server.
3. SSH deployed; registration, email verification, forgot password; search;
   GitHub import; this repo hosted on g1t.
4. Hosted agents in sandboxes behind the runner contract; agent
   definitions; AI Gateway; push events; checks.
5. Merge engine with structural merge; landing queue with speculative
   checks; projected main; resolve-on-move.
6. Arena, diffs, proof bundles, reviewer and adversarial reviewer, risk
   tiers; work registry with overlap radar,
   duplicate detection, handoff, ask and wait.
7. Adopting outside pushes; protected `main`; approval rules.
8. Projects with briefs, planner and dependency graph; mission control with
   the "needs you" inbox; live session pages and steering.
9. Why-blame, signed provenance, forkable sessions, digest and timeline,
   landing page.
10. Workspaces and initiatives; context hub (memory, unified search,
    Jira and Notion connectors); multi-repo intents.
11. Portfolio, standup and ask; checkpoints, stall detection, budgets.
12. Moving sessions between local and hosted; installable web app with
    notifications; preview URLs per attempt.
13. Docs view, document intents, templates, explain, living documentation,
    roles.
14. Automations: event bus, triggers, Sentry and generic webhook
    integrations, write-back.
15. Own keys, own endpoints, self-hosted runners; agent leaderboard and
    routing.
16. Large run (100+ agents across many intents), hardening, README, demo.

Later: code search, mirroring to GitHub, passkeys, SSH
on port 22 without the CLI proxy (needs the Workers inbound TCP private
beta).
