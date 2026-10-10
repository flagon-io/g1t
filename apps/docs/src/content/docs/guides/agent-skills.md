---
title: Agent skills
description: How agents use skills, the foundational skills every agent starts with, and your workspace's skill library in the open SKILL.md format - write, import, save from a session, attach, version, keep in a repository, and turn off.
---

Ask an agent for a PDF and you get a PDF. A **skill** tells an agent how to
do one kind of work well, with the tools it already has. Every agent starts
with g1t's **foundational skills** (documents, research, data, code,
communication, and files and media), and your workspace adds its own in
the **skill library**: how you cut a release, your brand voice, how you
triage a bug.

Skills never add a tool or a permission. A skill names the tools it uses,
and the agent uses them with the access of the person who asked, narrowed
to what everyone in the conversation may see
([what agents can do for whom](/guides/agent-access/)). Where a tool isn't
available, such as code tools in a channel whose members can't all read
code, the agent is told that part of the skill doesn't work there. A skill
can't change who the agent acts for or set aside its rules.

## How agents use skills

Skills load as they are needed, so a hundred of them cost a line each, not
their whole text, on every reply:

1. On every reply and every [session](/guides/agent-sessions/) step, the
   agent's instructions list each skill it has, by its name and when to use
   it.
2. When a request matches a skill, the agent reads it with the `use_skill`
   tool before it starts, then follows it.
3. A skill that points to one of its files, such as
   `resources/template.md`, is read the same way: `use_skill` with `name`
   and `file`.

Reading a skill counts as one of the reply's tool calls. An agent without
any tools (its first hello) has no skills listed.

Each foundational skill also says, part by part, what isn't possible yet.
The agent is told the same, so when you ask for something that is coming it
says so and offers what it can do instead.

## See an agent's skills

1. Open **Agents** in the dock and choose an agent.
2. Open its **Skills** tab.

**Foundational, from g1t** shows each foundational skill: a check on each
part that works today with the tools that part uses, and **Coming** on each
part that doesn't yet. **Read the playbook** shows exactly what the agent
reads when it uses the skill.

**From your library** lists the library's skills that reach the agent:
attached to it, to a team it is on, or to every agent, with the version it
uses. **Update to v4** appears when a newer version is out and you may move
it there.

## The foundational skills

The foundational skills are versioned together (version `2026.10` now) and
updated with g1t's releases. Each is written out in the same SKILL.md format
as your own (open it under **Agents → Skills**), and owners turn each off
per agent.

### Documents

| Part | Status | How |
| --- | --- | --- |
| Write and edit docs in Artifacts | Live | `create_artifact`, `edit_artifact`, `read_artifact`. Markdown with tables, task lists, callouts and Mermaid charts. |
| Make PDFs | Live | `make_file` with format `pdf`, from Markdown, attached to a doc. |
| Word documents | Live | `make_file` with format `docx`, from Markdown, attached to a doc. |
| Spreadsheets | Live | `make_file` with format `xlsx` (one or more sheets) or `csv` (one sheet). |
| Slide decks | Coming | Comes with slides in Artifacts. Until then, the agent offers an outline as a doc or a PDF. |

### Research

| Part | Status | How |
| --- | --- | --- |
| Reports with sources | Live | From the workspace's docs, code and chat (`search_artifacts`, `read_artifact`, `search_code`, `read_file`, `search_messages`, `read_thread`), each source linked; long reports as a doc with a Sources section. |
| Search the web | Coming | Comes with web access, set per team. |
| Browse and read pages | Coming | Comes with web access, set per team. |

### Data

| Part | Status | How |
| --- | --- | --- |
| Analyze files and tables | Live | CSV, JSON and log files in repositories (`read_file`) and tables in docs (`read_artifact`). The model works the numbers itself, without running code, so it says what it totalled and calls large results estimates. |
| Charts in docs | Live | Bar, line and pie charts drawn from Mermaid in a doc. |
| Spreadsheets of results | Live | `make_file` with format `xlsx` or `csv`. |
| Dashboards | Coming | Comes with dashboards in Artifacts. |
| Query databases and forks | Coming | Comes with workspace datasets and database connections. |

### Code

| Part | Status | How |
| --- | --- | --- |
| Read and explain code | Live | `list_repositories`, `search_code`, `read_file`, `recent_activity`, in repositories everyone in the conversation can read. |
| Review pull requests | Live | `get_pull`, `review_pull`, `comment`. Reviews are advisory: people still give the approvals a merge needs. |
| Open pull requests | Live | `draft_issue`: the agent drafts the issue, a person files it, and assigning it to `@g1t` makes the pull request on a runner, with checks and revisions. |
| Run code on its runner | Coming | Comes with agents on runners. |
| Write and run tests itself | Coming | Comes with agents on runners. `@g1t` runs tests on issues assigned to it today. |

### Communication

| Part | Status | How |
| --- | --- | --- |
| Draft emails and messages | Live | Written ready to send, in a code block or a doc. Agents don't send email; you do. |
| Summarize threads | Live | `read_thread`, `search_messages`: what was decided, what is open, and who owns each next step, with links. |
| Find times and book meetings | Coming | Comes with calendar integrations. |

### Files and media

| Part | Status | How |
| --- | --- | --- |
| Convert between formats | Live | Markdown, text and tables to PDF, Word, Excel, CSV or Markdown with `make_file`, including files read from a repository or a doc. |
| Diagrams | Live | Flowcharts, sequences and timelines from Mermaid in a doc. |
| Read scans and images | Coming | Comes with image input for agents. |
| Create and edit images | Coming | Comes with image models. |

## Files agents make

`make_file` writes the file itself, inside g1t, and keeps it with a doc in
Artifacts:

- **Without a doc named**, it makes a new doc that holds the content (or,
  for a spreadsheet, a preview of its first rows) and attaches the file.
  The doc goes where `create_artifact` would put it: shared with the
  conversation in a direct message or private channel, the General space in
  a public channel.
- **With a doc named**, it attaches the file to that doc. The person who
  asked must be able to edit it.

Either way, the doc gets a link to the file, and the agent answers with the
file's link. Files are served from the usercontent address
(`g1tusercontent.com` on g1t.sh), like files you put in a doc yourself.
When not everyone in the conversation can open the doc, the agent sends
the link to the person who asked, in their direct message with it, and says
only that it made something.

| Format | From | Notes |
| --- | --- | --- |
| `pdf` | Markdown | US Letter, numbered pages, links you can click. Headings, paragraphs, bold, italic, code, lists, quotes, code blocks and tables. Standard fonts, so text is Latin script: accents are kept, other scripts are not. At most 300 pages. |
| `docx` | Markdown | The same blocks as a Word document, with real headings and tables. |
| `xlsx` | Rows | Up to 10 sheets, 5,000 rows and 50 columns each. The first row is the header, in bold and frozen. Numbers stay numbers; codes with a leading zero stay text. |
| `csv` | Rows | One sheet, UTF-8. |
| `md` | Markdown | The Markdown as written. |

A file is at most 25 MB. Mermaid charts and images show in the doc but not
in a PDF or Word file, where a chart's source is kept as code.

## The skill library

Your workspace's own skills are under **Agents → Skills**. The library
lists drafts waiting for review first, then every skill with its version
and where it is attached, then g1t's foundational skills, which you can
open to read as SKILL.md.

A skill does nothing until it is attached. Open it and choose **Attach**:

| Attach to | Who gets it | Who can attach it there |
| --- | --- | --- |
| Every agent in the workspace | Every agent, `@g1t` included | Owners |
| A team | Every agent on the team: added to it, or whose home team it is | Owners, and the team's maintainers |
| One agent | That agent | Owners |

An agent gets each skill once. When a skill reaches it in more than one
way, the attachment closest to it decides the version: the agent's own,
then its teams', then the workspace's.

### Who can do what

| | Members | Team maintainers | Owners |
| --- | --- | --- | --- |
| See the library and every skill | Yes | Yes | Yes |
| Save a finished session as a draft | Yes | Yes | Yes |
| Write and import skills, publish drafts | No | Yes | Yes |
| Edit or delete a skill | No | The ones they wrote, used only by their teams | Any |
| Attach, detach and move versions | No | On the teams they maintain | Anywhere |
| Turn a skill off for one agent | No | No | Yes |
| Link a repository | No | No | Yes |

Every change is in the workspace's audit log under `agents/skills/<name>`.

## The skill format

A skill is a folder in the open SKILL.md format, the same one other agent
tools read, so a skill written elsewhere imports as it is:

```text
release-notes/
├── SKILL.md
├── resources/
│   └── template.md
└── scripts/
    └── collect.py
```

`SKILL.md` starts with YAML front-matter, then the instructions in
Markdown:

```markdown
---
name: release-notes
description: Use when someone asks for release notes or a changelog for a version.
tools: [recent_activity, get_pull, create_artifact, make_file]
---

# Release notes

1. Read the pull requests merged since the last tag (`recent_activity`).
2. Group them by area: Added, Changed, Fixed.
3. Write the notes as a doc, linking each pull request. Use resources/template.md.
```

| Key | Required | What it is |
| --- | --- | --- |
| `name` | Yes | Lowercase letters, digits and single hyphens, at most 64 characters. Agents ask for the skill by it. The foundational skills' names (`documents`, `research`, `data`, `code`, `communication`, `files`) are taken. |
| `description` | Yes | When to use it, at most 1,024 characters. Agents read it on every reply to choose the skill, so start with "Use when". |
| `tools` | No | g1t's own key: the agent tools the skill uses, as a list or separated by commas. Only tools agents have are accepted (see below). Naming a tool never gives it to an agent. |
| `requires_computer` | No | g1t's own key: `true` for a skill that needs the agent's own computer. A skill with files in `scripts/` needs one whatever it says. |
| Anything else | No | `license`, `metadata`, `allowed-tools` and other keys are kept as written and change nothing. |

Other files go in `resources/` (templates and references the instructions
point to; `references/` and `assets/` work too) and `scripts/`.

The tools a skill can name: `list_repositories`, `search_code`,
`read_file`, `list_issues`, `get_issue`, `get_pull`, `recent_activity`,
`draft_issue`, `comment`, `review_pull`, `search_artifacts`,
`read_artifact`, `list_spaces`, `stale_artifacts`, `create_artifact`,
`edit_artifact`, `share_artifact`, `make_file`, `search_messages`,
`read_thread`, `workspace_roster`, `ask_colleague`, `hand_off`,
`start_session`, `post_update`, `use_subagent`, `bring_in`, `use_skill`,
`remember` and `forget`.

| Limit | |
| --- | --- |
| One skill's folder | 1 MB, every file together, and at most 200 files |
| Skills from the library per agent | 100. Past that, the agent gets its own attachments first, then its teams', then the workspace's, and its Skills tab says how many it is missing. |
| Skills in a workspace's library | 1,000 |
| An upload | 2 MB |

### Scripts and the agent's computer

Scripts run only on an agent's own computer, which is coming. Until then a
skill that needs one is marked **Needs a computer · Coming**: its scripts
are kept with it and never run, and agents follow the parts of it that
don't need them and never say they ran a script. They can still read a
script's text with `use_skill`.

## Write a skill

You need to be an owner or a team maintainer.

1. Open **Agents → Skills** and choose **Write a skill**.
2. Give it a **name** and say **when to use it** in one sentence.
3. Write the **instructions** in Markdown, in the second person: the steps,
   what to read first, the checks before it's done. **Preview** shows them
   rendered.
4. Tick the **tools it uses**, and add **files** to `resources/` or
   `scripts/`.
5. Choose **Add to the library**, then **Attach** it where it belongs.

g1t writes the SKILL.md for you. **Show SKILL.md as written** on the
skill's page shows it.

## Versions

Every save is a new version, listed under **Versions** on the skill's page
with who made it, where it came from and an optional note. Choose one to
read it as it was.

Each attachment pins the version its agents use, so an edit never reaches
an agent you didn't mean it to:

- When you save, **Use the new version wherever I can change it** (on by
  default) moves the attachments you may change. The others keep their
  version.
- An attachment on an older version shows **Update to v4** on the skill's
  page and on the agent's Skills tab. Choosing it moves that attachment,
  for every agent it reaches.

Saving with nothing changed doesn't make a version.

## Import a skill

You need to be an owner or a team maintainer. Open **Agents → Skills** and
choose **Import**.

- **Upload** a `SKILL.md`, or a zip of the skill's folder. A zip holding one
  folder (as zipping a folder makes it) is read as that folder.
- **From a repository**: a repository you can read (`workspace/name`), the
  folder holding `SKILL.md`, and a branch, tag or commit (the default
  branch when empty). It is read once, and the commit is kept with the
  version.

A skill whose name the library already has is refused, unless you tick
**If the library has a skill with its name, make this its new version**.

## Save a session as a skill

When an agent finishes a [session](/guides/agent-sessions/) the way you'd
want it done again:

1. Open the session and choose **Save as skill**.
2. The agent drafts a skill from the transcript: its steps, what it read
   first and the checks it made, without names of people, secrets or
   one-off details. The draft is billed as the agent's work, like a short
   session step.
3. The draft waits under **Drafts to review** in the library. No agent uses
   it, and it can't be attached.
4. An owner or team maintainer opens it, chooses **Review and publish**,
   changes what's wrong, and chooses **Publish**.

Anyone who can see the session can save it. Whoever saved a draft, owners
and team maintainers can discard it.

## Keep skills in a repository

The library is the place you write skills. Optionally, it can follow a
repository, so skills go through the same pull requests and reviews as
code:

1. Open **Agents → Skills**. Under **Keep skills in a repository**, enter
   the repository as `workspace/name` and choose **Link repository**.
   Owners only.
2. Each folder in `.g1t/skills/<name>/` on its default branch becomes the
   skill `<name>`. The folder's name and the `name` in its `SKILL.md` must
   match.
3. Every push to the default branch that changes a folder publishes a new
   version of that skill and moves all its attachments: the repository's
   review is the review. **Read it again** reads it on demand.

A skill from the repository is marked **From the repository** and is
changed there, not in the editor. A folder whose name the library already
uses for a skill written here is skipped and listed under the panel, as is
a folder that isn't a valid skill. When a folder is removed from the
repository, its skill stays in the library and can be edited here again.
**Stop following** does the same for every skill.

Writing edits made in the library back to the repository as a commit is
coming.

## Turn a skill off

Owners can turn any skill off for one agent, foundational or from the
library, for example Communication for an agent that only reviews code.

1. Open the agent's **Skills** tab.
2. Switch the skill off.

Turning a skill off takes it out of the agent's instructions. It doesn't
take tools away: tools come from what the agent is and where it is asked,
not from skills. The change is a new version of the agent, listed on its
**Profile** tab with the others. A library skill stays attached; to remove
it everywhere, detach it on its page.

Members see each skill as **On** or **Off**.

## Web access

Research on the open web comes with web access, set per team: the open web,
approved sites only, or off. It is coming; until then no agent reads the
web.

## Coming

| What | Status |
| --- | --- |
| Skills from the [Marketplace](/guides/marketplace/): an extension's skills, added in one step | Coming |
| Running a skill's scripts on the agent's own computer | Coming |
| Writing library edits back to the linked repository | Coming |
