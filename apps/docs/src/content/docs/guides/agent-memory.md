---
title: Agent memory
description: What an agent remembers between conversations, where each fact came from, and where it may be recalled. Scopes keep private conversations private; people pin, correct and forget facts.
---

An agent has **no hidden memory**. Apart from its own definition, it knows
only what it reads through a tool while it works, and the facts on its
**Memory** tab. Every fact says where it came from, and its **scope**
decides, in code, where it may be recalled and who may see it.

## Scopes

| Scope | Recalled | Who can see and change it |
| --- | --- | --- |
| **Workspace** | Anywhere in the workspace, for anyone. | Everyone sees it. Owners add, correct and forget it. |
| **Conversation** | Only in the channel it came from, and that channel's threads. | People in that channel. |
| **Just you** | Only in your direct messages with the agent. | Only you. |

An agent keeps a workspace fact only when it learned it somewhere every
member can already read, such as a public channel, or when an owner gives it
one. A fact from a private channel stays in that channel; a fact from your
DM stays with you.

Owners don't see other people's private facts. Owners control money and
agents, not other people's conversations.

## Where facts come from

| Source | For example |
| --- | --- |
| **A message** | Something said in `#support`: *The Enterprise plan includes SSO.* |
| **A session** | A session's report: *The nightly export runs at 02:00 UTC.* |
| **A person** | Someone told it, on its Memory tab or in chat: *Releases go out on Thursdays.* |

Each fact shows who kept it (the agent, or the person who told it), its
source and when. When someone corrects a fact, its source becomes them,
marked *corrected*.

## Add a fact

1. Open the agent, then **Memory**.
2. Under **Add a fact**, write it in a sentence, up to 500 characters.
3. Choose who it is for: **Just me**, **This workspace** (owners only), or **A channel** you are in.
4. Choose **Remember**.

Facts you add are pinned.

## Pin, correct and forget

Hover a fact to:

- **Pin** it: pinned facts come first whenever the agent recalls facts for
  that place.
- **Edit** it: correct it in place. The agent uses the corrected fact from
  its next reply.
- **Forget** it: it is deleted and never recalled again. The agent can
  learn it again if it comes up.

You can change any fact you can see, except workspace facts, which only
owners change.

## Limits

| | |
| --- | --- |
| One fact | Up to 500 characters, one paragraph. |
| Facts per agent | 2,000. Past that, it must forget before it remembers. |
| Facts per reply or session step | The 40 that apply to that place, pinned first. |

Customer-data files are never remembered. See
[what agents can do for whom](/guides/agent-access/#what-an-agent-can-and-cant-know).

## Next

- [Sessions](/guides/agent-sessions/): the work that teaches agents most of what they know.
- [Agents](/guides/agents/): hiring agents from templates.
