# Channels

People and agents talk in the same place the code lives. A workspace gets
channels and direct messages, the way a team chat app has them, and every
channel can be linked to a project so its pull requests, issues, checks and
deploys arrive there as cards a person can act on. Agents are members of
channels like anyone else.

Design canvas: the "g1t Channels" artifact (v2 row is the target).

## The point

Today a person reads g1t in two places: g1t itself, and a chat app where
the team talks about what g1t is doing. Links get pasted across, approvals
wait in the wrong window, and an agent's question goes unseen. Channels put
the talk next to the work, and make one thing true everywhere: a thread
about a pull request *is* that pull request's conversation.

## Product model

- **Modes.** The shell gets a rail: Home, Code, Chat, Agents, Inbox. Code
  keeps today's sidebar exactly. Chat has a sidebar of its own. Inbox is
  shared by both. No mode's sidebar ever lists the other mode's things.
- **Channel.** Belongs to a workspace. Public or private. Optionally linked
  to one or more projects, and optionally to a team. Has members: people
  and agents.
- **Message.** Text by a person or an agent, or a card posted by g1t for an
  event (pull request opened, checks failed, deployed, an agent asking for
  approval).
- **Thread.** Replies under a message. A card about an issue or pull
  request opens that issue's or pull request's own timeline: replying there
  is commenting on it. Other threads belong to the channel.
- **Direct message.** A channel with no name, between two or more members,
  any of whom may be agents.
- **Project chat.** In Code mode, a project page shows a dock with only the
  channels linked to that project.

## Scaling the sidebar

Workspaces will have hundreds of channels. The Chat sidebar never lists
them all:

- **Starred** first, chosen by the person.
- **Active projects:** channels linked to projects the person worked on
  this week, computed, not chosen.
- **Teams:** one collapsed section per team the person is on, showing a
  count and what is unread.
- **Direct messages**, newest first.
- **All / Unread / Mentions** filter, and a jump box. Everything else is
  behind *Browse channels* and *Muted*.

## How it fits what exists

| Need | Already in g1t | What changes |
| --- | --- | --- |
| Live delivery | Durable Objects (runner, models) | One Durable Object per channel holds the open WebSockets, with hibernation. D1 keeps the messages. |
| Cards for events | `services/events` bus and per-subscriber queues (`g1t_contracts::subscribers`) | `chat` subscribes to pull, issue, check run, deployment and agent run types, and posts a card in each linked channel. |
| Mentions and unread | `services/events` inbox, threads and reasons | A message that mentions someone publishes `chat.message.created`; the inbox tells them with reason `mention`. Thread keys reuse `<repo_id>#<number>`. |
| Steering an agent | `agent_messages` in `services/work` | `@agent` in a pull request's thread becomes a steering message on that pull request. |
| One timeline | Issue and pull request timelines in `services/work` | The card's thread reads and writes that timeline. Chat stores only a pointer. |
| Navigation | `workspace-nav.ts`, `shell.tsx` | A rail, a `mode` beside `SidebarKey`, and a Chat sidebar. |
| Search | `services/search` | Index channel names and messages people can see. |

## Data

A new service, `services/chat` (TypeScript, like `services/projects`,
because the Durable Object and WebSocket code is simplest there), with its
own D1 database:

- `channels`: id, workspace, name, kind (`channel` | `dm`), private, topic,
  team_id, created_by, archived_at.
- `channel_links`: channel_id, project_id. What makes a channel a
  project's chat, and where cards go.
- `channel_members`: channel_id, principal (person or agent), role,
  starred, section, muted, last_read_id, joined_at.
- `messages`: id (time-sortable), channel_id, author, kind (`text` |
  `card`), body, card (JSON: subject key, state, actions), thread_root,
  reply_count, edited_at, deleted_at.
- `reactions`: message_id, principal, emoji.

Unread counts come from `last_read_id` against the newest message id, kept
in the channel's Durable Object, so the sidebar needs one read per
section, not per channel.

## Agents in channels

- An agent is added to a channel like a person, with the agent's own
  credentials, guardrails and audit log. Private channels exclude agents
  unless added by name.
- A mention in a pull request's thread steers that pull request's agent
  (`agent_messages`). A mention anywhere else starts an agent run whose
  replies post in the thread.
- Asking a person for approval (merge past branch protection, deploy to
  production) posts a card with the actions on it, and the same item lands
  in the person's inbox. Acting in either place resolves both.

## Build order

1. **Contracts.** Channel, message and card types in `packages/contracts`
   and `crates/contracts`; the RPC methods; the new event types.
2. **Channels.** `services/chat`, its migrations, a Durable Object per
   channel, and `deploy/stack.jsonc` entries. Create, join, post, edit,
   threads, reactions, read state.
3. **Chat mode.** The rail in `shell.tsx`; the Chat sidebar with starred,
   sections, filters and browse; the channel page; the composer with
   mentions. Code mode is unchanged apart from the rail.
4. **Mentions to the inbox.** `chat.message.created` and inbox rows with
   reason `mention`.
5. **Project links and cards.** Link a channel to a project; the events
   subscriber; cards for pull requests, issues, checks and deploys; the
   project chat dock in Code mode.
6. **One timeline.** A card's thread is the issue's or pull request's
   timeline, both ways, with "also send to channel".
7. **Agents.** Agents as members, steering by mention, approval cards,
   direct messages with agents.
8. **Scale.** Team sections, computed active-project section, muting,
   browse, search.

Steps 1 to 4 are a usable chat; 5 and 6 are what no chat app can do.

## Open questions

- Must every channel belong to a project or team? Requiring one makes the
  sidebar's sections better and orphans fewer channels.
- Do agents get their own mode, or only appear as direct messages?
- Retention and export for workspaces that need it.
- Does a self-hosted install ship chat, or is it hosted only at first?
