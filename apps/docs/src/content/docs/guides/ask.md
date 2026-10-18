---
title: Ask g1t
description: Ask g1t about your work from the top bar of any page. It answers with your workspace's own AI provider and key, reads g1t as you with read-only access, and shows each step it takes and the pages it drew on.
---

**Ask**, in the top bar, opens a conversation with g1t beside the page
you are on. Ask about the work item you are reading, the pull request you are
reviewing, or anything else about your work, and the answer streams in as
it is written.

Ask answers with **your workspace's own AI provider**, on your workspace's
own key: one of [your AI providers](/guides/ai/),
and **Auto** or the model an owner chose for it. g1t hosts no model for Ask and bills
nothing for it; what an answer costs is on your provider's bill. Your key
stays sealed in g1t: it is used to call the provider and is never sent to
your browser.

## Set it up

An owner of the workspace sets it up once:

1. Open **AI**, in the workspace's settings, at
   `g1t.sh/<workspace>/-/ai`.
2. Add a provider if there is none yet: a frontier lab such as
   Anthropic, OpenAI or Gemini, a model platform, or a model you host
   yourself behind an Anthropic- or OpenAI-compatible endpoint.
3. Under **Ask g1t**, choose the provider and its model, then **Use for
   Ask**. The model starts at **Auto** (see [Auto](#auto)); choose one of
   the models the provider offers to use that one for every answer. For
   Azure OpenAI, give the deployment's name; for an endpoint that does not
   list its models, the model's name.

Every member can then ask. Until a provider is chosen, Ask says so: owners
get a link to set it up, and members are told to ask an owner. A message
to @g1t in Chat before then gets a short reply from g1t saying the same. **Turn Ask
off** on the same page stops it answering, and removing the provider it
uses does too.

Every AI provider g1t connects works with Ask: Anthropic and
Anthropic-compatible endpoints through Anthropic's Messages API, and the
rest through OpenAI's Chat Completions API.

### Auto

**Auto**, the default, picks one of the provider's models for each
question, by a fixed rule and with no extra call to the provider:

| The question | Auto answers with |
| --- | --- |
| A lookup: who has a work item, a link, how many pull requests are open | The provider's newest fast model: Haiku, a `mini` or `flash` model, an `instant` one |
| One that needs several reads or reasoning: why or how something happened, what shipped, a day or a week summed up, a failure to diagnose, work to plan; a long question, several at once, or a long conversation | Its newest standard model: Sonnet, GPT, Gemini Pro, a `versatile` or `large` one |

Auto tells models apart by the words in their names, from the list the
provider gave when it was last tested, so it works the same for every
provider. The largest and most expensive models, such as Opus or OpenAI's
`pro` models, are used only when the provider offers nothing else: every
answer is on your workspace's key. When a tier is missing, Auto uses the
nearest one. A provider that lists no models (an endpoint, an Azure
deployment) answers with its own model. If Auto has nothing to choose
from, Ask says so: test the provider to list its models again, or choose
one.

Each answer names the model that wrote it, such as **Anthropic · Auto ·
claude-sonnet-5-5**. Workspaces that chose Ask's model before Auto existed
and kept the one the picker started at moved to Auto; a model an owner
picked stays picked.

## What it can read

Ask reads g1t to answer: whatever you can read, and nothing more. It uses
the same tools the [g1t MCP server](/reference/mcp/) gives any agent, run
as you: repositories and their files and commits, work items, pull requests
and their changes, workflow runs and their logs, deployments, releases,
production telemetry, and what happened across your workspace. Every read
goes through the same permission checks as your own, so it never sees a
repository, work item or log you could not open yourself.

Each question asked from the panel is sent with a short note saying that
this is Ask in your workspace and which page you are on (a question
written in Chat says you are in Chat): the repository, and the work item or
pull request number, when there is one. On a work item or a pull request,
g1t also
reads its title, state and description, as you can see them, and sends
those along, so you can ask "what is left to do here?" without pasting
anything.

It only reads. For each answer g1t makes a credential that is yours, holds
read permissions only, reaches only this workspace, and ends with the
answer, a few minutes at most. Nobody sees it: not the model, not your
browser. Anything that would change g1t is refused, whatever your role.

Each question is also sent with which page you are on and today's date. On
a work item or a pull request, g1t sends its title, state and description, so
you can ask "what is left to do here?" without pasting anything. Some
questions it answers well:

- What shipped today across all our projects?
- Why did the last Deploy fail?
- Summarize this pull request.
- How do I run this project's tests?
- What changed in this file recently, and why?

For a question about the whole workspace, Ask reads the workspace's
activity first: merged pull requests, releases, deployments, workflow runs
and pushes across every repository you can read, in one read
(`activity` on the MCP server's `workspace` tool, or
[`GET /workspaces/{workspace}/activity`](/reference/api/workspaces/get-workspace-activity/)).

### What Ask means by shipped

A change ships when it reaches a repository's default branch, pushed or
merged from a pull request, and then production. Production is a
successful deployment:

- a project's production deployment on g1t.page, or
- for a repository that deploys itself, a successful run of its deploy
  workflow on the default branch: a workflow whose name or file says
  deploy, such as `.g1t/workflows/deploy.yml`, and not one for previews.

Releases and tags are one more signal, not what shipping means. So "What
shipped today?" is answered with the commits that reached default branches
since the start of your day (in your profile's time zone), grouped by what
changed, and for each: **live** (with the deploy that carried it), **still
deploying**, **failed to deploy** (with the run, linked), or **not
deployed**. A deploy carries the commit it ran for and every commit before
it on the branch.

People are named by their g1t username. A commit's author is matched to
the account their address belongs to (a confirmed address or the account's
noreply address, as commits on g1t.sh show them); a commit by an address
no account has is named as git recorded it, without an @.

Answers link to what they name on g1t, and every number, title and link
comes from what Ask read; when something does not exist, it says so.
Answers come from a model and can still be wrong: follow the links to
check.

### Steps and sources

While Ask works, the panel shows each step as it runs, such as **Read
activity in acme since 2026-10-12** or **Read pull request #7 in
acme/web**, with what it found and a link to the page it read. A step that
was refused, or that failed, says why. Once the answer is written the steps
fold into one line you can open again. Under the answer, **Sources** lists
the pages on g1t it links to, and the ones it read directly.

### Asking for work

Ask does not do the work itself: it does not write code or change
anything. g1t coordinates the work, and a session in your own harness does
it. When you ask for work to be done, such as planning a change, fixing a
bug or implementing a work item, Ask reads the work item the work belongs
to, checks whether a session already holds it, and proposes a session: a
card under the answer that names the work item (or a new one it would
open) and
what the session should do (plan, implement or review).

Nothing starts until you choose on the card:

- **Start session** runs it on your workspace's Anthropic account as a
  [Claude Managed Agents session](/guides/sessions/#start-a-session-on-your-anthropic-account), with g1t's tools and
  skills beside your own. It shows when an owner has connected Anthropic.
- **Copy Claude Code command** copies a `claude` command that runs it on
  your computer with the [g1t plugin](/guides/claude-code-plugin/), with
  your own skills, settings and subagents.

Either way the session is tied to the work item: it shows on the work
item, on the workspace's [Sessions](/work/sessions/)
and on its own session page, with
its subagents, and Ask can tell you where it stands. If a session already
holds the work item, Ask
links it rather than proposing another.

### Building something new

Ask for something that has no repository yet, such as "build a status page
for our API", and the card proposes a new one in your workspace: **Build
"Status page" in acme/status-page**. Under its title it says what starting
it does, for example "Creates the private repository, turns on its
deployments, then runs in your own harness and pushes the first version,
which goes live on g1t.page." The repository is public only if you ask for
that, and deployments are left off if you ask for that too.

Choosing **Start session** or **Copy Claude Code command**:

1. Creates the repository as you, with the work item's title as its project's
   description.
2. Turns on its [deployments](/guides/deployments/). This needs the
   workspace on the g1t plan and the Admin role on the repository, which
   you have as its creator. If it can't, the card says **Not deployed:**
   and why, and the session still builds the app.
3. Opens the work item, with the new repository as its origin, and starts
   the session.

The card then shows **Created** with a link to the repository, and **Live
once the first version is pushed at** its production address on
g1t.page. The session pushes its first working version straight to the
default branch, since an empty repository has nothing to open a pull
request against, closes the work item, and watches `g1t deploy list` until
production is live, ending its report with the address. Every change after
that goes through pull requests as usual. Choosing the card again, or Copy
after Start, uses the repository it already made.

Ask itself still changes nothing: your click on the card does. For a
repository that already exists, deployments are turned on in its
**Settings → Deployments**.

## Ask from Home

[Home](/guides/home/#ask-from-home) asks g1t for you in three places, all
in the same conversation as the panel:

- **The box at the top**, under **What are we building today?**, and its
  starters (**What needs me first?**, **What shipped today?**, **Who's
  working on what?**). What you send there opens the Ask panel and is
  sent as if you had typed it in the panel.
- **Explain**, on each row of **Landed**, asks what that one change did,
  why, and whether it is live, in the panel.
- **Summarize**, on **What changed**, writes g1t's plain-English summary
  of the span on Home itself, rather than in the panel. **Ask a
  follow-up** under it opens the panel on the same conversation.

When Ask is not set up yet, or g1t is still answering an earlier
question, the panel opens with the question in its box instead of
sending it; send it once it can be answered.

## One conversation, in Ask and in Chat

Ask is your **direct message with @g1t** in [Chat](/guides/chat/#talk-with-g1t).
What you ask in the panel is posted there, and g1t's answer is written
there as it streams, so it shows in both places at once: start a question
on a work item's page, and read the answer later in Chat, on your phone, or
in the desktop app. **Open in Chat** at the top of the panel takes you to
it. Nobody else can read it, and it stays until you delete it or
[clear it](#clear-the-conversation).

- **New conversation** leaves a mark in the direct message. From then on,
  g1t reads only what comes after it, and the panel shows only that; what
  came before stays in Chat to read.
- **Clear conversation…**, in the panel's **⋯** menu, deletes the whole
  conversation for good. Typing `/clear` and pressing **Enter** does the
  same. See [Clear the conversation](#clear-the-conversation).
- **Stop**, or **Esc** while an answer is coming, ends the answer; what had
  come so far stays. Writing again while g1t is still answering does the
  same: g1t stops and answers your newest words, reading both.
- **Answer again**, under g1t's latest answer, has it write that answer
  anew.
- **Copy** copies an answer as Markdown. Each answer shows the provider
  and model that wrote it, with **Auto** when Auto chose the model.

Answers are Markdown: code is highlighted with its language and a Copy
button, tables scroll within the answer, and work items, pull requests and
commits (`#12`, `acme/web#12`, a link to one, a commit hash) show as chips that
open their title and state when you hover over them. Links to
[artifacts](/guides/artifacts/) show their card. Pictures show only from
g1t itself; any other picture is a link.

In the panel, **Enter** sends, **Shift+Enter** starts a new line, and
**⌘K** (**Ctrl+K**) puts you back in the box. On an empty conversation,
the panel suggests a few questions for the page you are on.

## Clear the conversation

**New conversation** only changes what g1t reads: everything said before
the mark is still kept, and still in Chat. To delete it, clear the
conversation:

1. Open **Ask** in the top bar, or your direct message with **g1t** in
   Chat.
2. Choose **⋯ → Clear conversation…**, or type `/clear` in the box and
   press **Enter**.
3. Choose **Clear conversation** to confirm.

Everything in your direct message with g1t is deleted for good, in Ask
and in Chat, on every device. It can't be undone, and g1t remembers none
of it: the next question starts with nothing before it.

| Deleted | Kept |
| --- | --- |
| Your questions, and the page each was asked from | The direct message itself, empty, so Ask and Chat open it as before |
| g1t's answers, with their steps, sources and proposed sessions | Chat's daily count of messages and bytes for the workspace, which has no text and no names in it and is kept for billing |
| Thread replies, reactions, "New conversation" marks, and deleted messages' empty places | Work items, pull requests and sessions you started from an answer: they are your workspace's, not the conversation's |
| Your read mark and unread count for it | What your AI provider was sent to answer: it went to the provider, under your workspace's agreement with them |
| The notifications its answers sent you, in g1t's notifications panel | Browser and phone notifications already shown on a device |

An answer still being written when you clear is stopped and thrown away,
not saved: it never comes back to the conversation, and it does not
notify you. A question you send after clearing is answered as the start
of a new conversation.

Clearing is only ever your own: nobody else can clear your conversation
with g1t, not even a workspace owner, and you can't clear anyone else's
or a channel. Clearing a conversation that is already empty does nothing.

## Limits

- 20 questions a minute for each person; past that, g1t says to wait a
  moment.
- g1t reads the conversation since the last **New conversation**, up to
  its latest 40 messages and 64,000 characters, the newest first; a
  message longer than 16,000 characters is cut to that.
- An answer is at most 4,096 tokens long, and says when it was cut off.
- An answer reads g1t in at most 10 rounds and 30 reads, over at most 2
  minutes; then it answers with what it has read and says what it could
  not check.
- The model is given at most 16,000 characters of any one read and 120,000
  in all. A longer read is trimmed: long lists keep their first items (a
  job's log keeps its end, where a failure says why), long texts are
  shortened, and each says how much was left out.
- Its reads count against the [API's rate limit](/reference/rate-limits/)
  like any other access token's. Each step is also a call to your AI
  provider, on your provider's bill.
