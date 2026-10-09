# Channels and crew

People and agents work in the same place the code lives. You talk to an
agent the way you talk to a teammate: message it directly, or invite it into
a channel and mention it. You create as many as you want and give each a
name, a job and its own limits. Issues and pull requests still exist and
still work exactly as they do today, but they become the record of the work,
not the way you start it.

Design canvas: the "g1t Channels" artifact (v2 row is the target).

## The point

Today you reach an agent through an issue: write it up, assign `g1t`, wait.
That is right for planned work and wrong for everything else, which is most
of a day: "why is this check flaky", "take #418 over the line", "keep an eye
on the deploy", "what changed in billing this week". A chat app with a bot
in it answers faster but loses the work: nothing is tracked, nothing is
reviewable, and the bot has no business touching your code.

g1t does both. Conversation is how work starts. Every piece of work an agent
takes on is tracked as a task, lands as issues and pull requests when it
touches code, and stays linked back to the conversation it came from.

## What you can do

- **Message an agent.** Every agent has a direct message. Ask it something,
  give it a job, steer it while it works.
- **Invite agents into channels.** Mention one and it joins the thread.
  Invite it and it can see the channel and answer when mentioned or when
  its triggers fire.
- **Create your own crew.** "Make me a release manager called Ship" in any
  chat, or a form. Give it a name, a handle, an avatar, a job, a model, a
  budget, what it may touch and what wakes it. Make as many as you need.
- **Talk to several at once.** A group chat or channel with three agents
  and two people works the way you would expect: whoever is mentioned
  answers, and agents can ask and hand work to each other in the open.
- **See the work.** Every job is a live card in the thread: steps, the
  pull request it opened, checks, cost so far, and what it is waiting on.
- **Approve where you are.** When an agent needs a person, the approval is a
  card in the conversation and an item in your inbox. Acting in either
  place settles both.
- **Keep using issues.** Assign an issue to an agent, mention one in a pull
  request, run the planner. All of it still works, and shows up in the
  agent's DM and the linked channels.

## Better than Grok Bot

[Grok Bot](https://docs.x.ai/grok-bot) (xAI, in Cursor and SuperGrok plans)
sets the bar for named AI teammates: conversational setup, per-bot memory,
a persistent cloud computer, group chats, bots handing off to each other,
saved skills on a schedule, and Team Bots reachable in Slack. g1t matches
each of these and goes past them where Grok Bot is weak.

| | Grok Bot | g1t |
| --- | --- | --- |
| Create and name agents | Yes, by describing the job | Yes, in chat or a form; also a file (`.g1t/agents/<name>.md`) you can review and version |
| Where it works | One cloud computer shared by all your bots: files, logins and sessions are not isolated between them | Each run in its own sandbox with its own credentials, guardrails and audit log. Nothing leaks between agents unless you share it |
| Model | Chosen for you; no picker | Auto by default, or pin a model per agent; bring your own key or endpoint |
| Spend | Counts toward the plan's limit; no per-bot cap; a running bot can overshoot | A budget per agent and per workspace, enforced before a run starts and during it, shown live on the job card |
| Approvals | Asks when it decides it needs you | Required by policy: rulesets, branch protection, guardrails and the agent's own limits decide what needs a person. Not up to the agent |
| Code | Git commits as a routine trigger; Cursor for real coding | Native: issues, pull requests, reviews, checks, merge queue, previews and deploys |
| Tracking | Work lives in chat history | Every job is a task; code work becomes issues and pull requests linked to the thread; why-blame goes from a line to the conversation that asked for it |
| Teams | Team Bots: one shared bot, private chats per person, owner cannot read them | Agents belong to the workspace; channels are visible to members; DMs are private; the audit log covers every action either way |
| Memory | Per bot; hidden | Per agent and per workspace (Memory and Context pages), readable and editable, with sources |
| Bots together | Message each other, hand off | The same, plus they see what each other is changing (overlap) and ask questions that wait in the open |
| Triggers | Schedules, Slack messages, git commits, @bot on X | Schedules, any g1t event (opened, failed, deployed, mentioned, labelled), channel messages, webhooks |
| Openness | Closed; a SuperGrok link can never be undone | MIT, self-hostable, any MCP client joins as a participant, export everything |

The pitch in one line: **Grok Bot's teammates, with their own desks, their
own budgets, and a paper trail.**

## Product model

- **Modes.** The shell gets a rail: Home, Code, Chat, Crew, Inbox. Code
  keeps today's sidebar exactly. Chat and Crew have sidebars of their own.
  Inbox is shared. No mode's sidebar lists the other mode's things.
- **Agent.** A named member of a workspace: handle, display name, avatar,
  job (its instructions), model choice, budget, scopes (which projects and
  channels, read or write), skills, triggers and memory. Stored as an agent
  definition in the workspace library, optionally committed to a repository
  as `.g1t/agents/<name>.md`. Built-in roles (planner, implementer,
  reviewer, triage) are agents too, renamable.
- **Channel.** Belongs to a workspace. Public or private. Linked to zero or
  more projects and optionally a team. Members are people and agents.
- **Direct message.** A channel with no name. Any mix of people and agents.
- **Message.** Text by a member, or a card g1t posts for an event or a job.
- **Thread.** Replies under a message. A card about an issue or pull
  request opens that item's own timeline: replying there is commenting on
  it. Other threads belong to the channel.
- **Task.** One job an agent took on: who asked, in which thread, what done
  means, status, cost, and what it produced (issues, pull requests,
  deploys, files, answers). Tasks are the bridge: they start in
  conversation and end in the code.
- **Skill.** A saved procedure an agent can repeat, made by walking it
  through once in chat. Stored like an agent definition.
- **Trigger.** What wakes an agent without a mention: a schedule, a g1t
  event, a message in a channel it watches, a webhook.

## How a task runs

1. Someone asks in a DM or mentions an agent in a thread.
2. The agent replies with what it understood and, if it is not a pure
   question, opens a task card: the goal, what done means, the budget it
   will use.
3. It works in its own sandbox. The card updates live: steps, logs, cost.
4. When it changes code it opens a pull request in the usual way. The
   pull request links the task, and the card shows its checks. If the work
   is bigger than one change, it asks the planner, which opens issues with
   dependencies under the task.
5. Anything that needs a person (merging past protection, deploying to
   production, spending past its budget, reaching outside its scopes)
   becomes an approval card and an inbox item.
6. It posts what it did and closes the task. The thread, the task, the
   issues and the pull requests all point at each other.

A plain question ("why did this fail?") never makes a task. Mentioning an
agent in a pull request that already has one steers it instead.

## Creating an agent

In any chat: "make an agent called Ship that cuts releases for g1t every
Tuesday and asks me before tagging." g1t replies with a draft card:
name, handle `@ship`, avatar, job, model (Auto), budget, scopes
(`flagon-io/g1t`, write), skills (none yet), triggers (Tuesdays 9:00),
approvals (tagging a release). You edit any field on the card and confirm.
The same card is the form on the Crew page. Saving writes the definition,
posts an introduction in the channels it was added to, and opens its DM.

Inviting an agent into a channel shows what that gives it: the channel's
messages and, if the channel is linked to projects, read access to them.
Write access is never granted by an invite; it comes from the agent's
scopes.

## Scaling the sidebar

Workspaces will have hundreds of channels and dozens of agents.

- **Chat sidebar:** Starred; active projects (channels linked to projects
  you worked on this week, computed); one collapsed section per team you
  are on, with a count and what is unread; direct messages, newest first;
  All / Unread / Mentions filter and a jump box. Everything else is behind
  *Browse channels* and *Muted*.
- **Crew sidebar:** agents you talk to, then agents working right now with
  their task, then *All agents*. Each shows a status: idle, working,
  waiting on you.

## How it fits what exists

| Need | Already in g1t | What changes |
| --- | --- | --- |
| Agent definitions | `.g1t/agents/<name>.md` and the workspace library (PLAN: Defining an agent) | Adds handle, avatar, scopes, triggers and skills; created from chat |
| Runs, budgets, models | Runner contract, AI Gateway, billing, Auto routing | A run can belong to a task, not only a pull request |
| Steering and agents asking each other | `agent_messages` in `services/work` (message, question, handoff) | Delivered from and posted to threads |
| Guardrails and audit | Guardrails, rulesets, audit log | Decide which steps become approval cards |
| Live delivery | Durable Objects (runner, models) | One Durable Object per channel holds open WebSockets, with hibernation; D1 keeps the messages |
| Cards for events | `services/events` bus and per-subscriber queues (`g1t_contracts::subscribers`) | `chat` subscribes to pull, issue, check run, deployment and agent run types and posts cards to linked channels and to the asking thread |
| Mentions, approvals, unread | `services/events` inbox, threads and reasons | `chat.message.created` and `task.approval_requested` feed the inbox; thread keys reuse `<repo_id>#<number>` and add `task/<id>` |
| Memory | Memory and Context pages | An agent's memory is shown on its profile and editable |
| Navigation | `workspace-nav.ts`, `shell.tsx` | A rail, a `mode` beside `SidebarKey`, Chat and Crew sidebars |
| Search | `services/search` | Channel names, messages and tasks people can see |

## Data

A new service, `services/chat` (TypeScript, like `services/projects`, since
the Durable Object and WebSocket code is simplest there), with its own D1
database:

- `channels`: id, workspace, name, kind (`channel` | `dm`), private, topic,
  team_id, created_by, archived_at.
- `channel_links`: channel_id, project_id.
- `channel_members`: channel_id, principal (person or agent), role,
  starred, section, muted, last_read_id, joined_at.
- `messages`: id (time-sortable), channel_id, author, kind (`text` |
  `card`), body, card (JSON: subject key, state, actions), thread_root,
  reply_count, edited_at, deleted_at.
- `reactions`: message_id, principal, emoji.

In `services/work`, beside the runs:

- `tasks`: id, workspace, agent, asked_by, channel_id, thread_root, goal,
  done_when, status (`planned` | `working` | `waiting` | `done` |
  `cancelled`), budget, spent, created_at, closed_at.
- `task_links`: task_id, kind (`issue` | `pull` | `deploy` | `file`),
  subject key.
- `agent_runs` gains a nullable `task_id`.

Agent profiles (handle, avatar, scopes, triggers, skills) extend the
existing agent definition, not a new table elsewhere.

## Build order

1. **Contracts.** Channel, message, card, task and agent profile types in
   `packages/contracts` and `crates/contracts`; RPC methods; new event types.
2. **Channels.** `services/chat`, migrations, a Durable Object per channel,
   `deploy/stack.jsonc` entries. Create, join, post, edit, threads,
   reactions, read state.
3. **Chat and Crew modes.** The rail in `shell.tsx`; the Chat sidebar; the
   channel page; the composer with mentions of people and agents; the Crew
   page listing agents with status.
4. **Talk to an agent.** DMs with agents; a question gets an answer in the
   thread with no task; a job creates a task and a live task card; runs
   with a `task_id`.
5. **Create your crew.** The draft-card flow in chat and on the Crew page;
   handles, avatars, scopes, budgets; invite to channels.
6. **Approvals as cards.** Guardrails, rulesets and budgets raise approval
   cards and inbox items; acting in either settles both.
7. **Project links and the one timeline.** Channels linked to projects;
   event cards; the project chat dock in Code mode; a card's thread is the
   issue's or pull request's timeline.
8. **Agents together.** Several agents in one thread; questions and
   handoffs posted in the open; overlap shown on task cards.
9. **Skills and triggers.** Walk an agent through a procedure once and save
   it; schedules, g1t events and channel messages as triggers.
10. **Scale.** Team sections, the computed active-project section, muting,
    browse, search.

Steps 1 to 4 replace "assign an issue" as the everyday way to reach an
agent. Steps 5 to 7 are where g1t passes Grok Bot.

## Open questions

- Must every channel belong to a project or team?
- Does every task show up in the issue list, or only tasks that produced
  issues? (Suggested: only those, with a Tasks tab per project.)
- Can a person's own Claude Code or Cursor session be invited into a
  channel as a member, the way it joins over MCP today?
- Should agents be reachable from Slack too, one app per workspace with a
  handle per agent, for teams that will not move their chat?
- Retention and export, and whether self-hosted installs ship chat at
  first.
