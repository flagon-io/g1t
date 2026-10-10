---
title: Agent skills
description: The foundational skills every agent starts with (documents, research, data, code, communication, files and media), what each does today, the tools it uses, what is coming, and how owners turn one off.
---

Ask an agent for a PDF and you get a PDF. Every agent starts with g1t's
**foundational skills**: documents, research, data, code, communication,
and files and media. A skill is a playbook. It tells the agent how to do a
kind of work with the tools it already has, and it is part of the agent's
instructions on every reply and every [session](/guides/agent-sessions/).

Skills never add a tool or a permission. A skill names the tools it uses,
and the agent uses them with the access of the person who asked, narrowed
to what everyone in the conversation may see
([what agents can do for whom](/guides/agent-access/)). Where a tool isn't
available, such as code tools in a channel whose members can't all read
code, the agent is told that part of the skill doesn't work there.

Each skill also says, part by part, what isn't possible yet. The agent is
told the same, so when you ask for something that is coming it says so and
offers what it can do instead.

## See an agent's skills

1. Open **Agents** in the dock and choose an agent.
2. Open its **Skills** tab.

Each skill shows what it can do, a check on each part that works today with
the tools that part uses, and **Coming** on each part that doesn't yet.
**Read the playbook** shows exactly what the agent is told while the skill
is on.

## The foundational skills

The foundational skills are versioned together (version `2026.10` now) and
updated with g1t's releases.

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

## Turn a skill off

Owners can turn any foundational skill off for one agent, for example
Communication for an agent that only reviews code.

1. Open the agent's **Skills** tab.
2. Switch the skill off.

Turning a skill off takes its playbook out of the agent's instructions. It
doesn't take tools away: tools come from what the agent is and where it is
asked, not from skills. The change is a new version of the agent, listed on
its **Profile** tab with the others.

Members see each skill as **On** or **Off**.

## Web access

Research on the open web comes with web access, set per team: the open web,
approved sites only, or off. It is coming; until then no agent reads the
web.

## More skills

| Source | Status |
| --- | --- |
| Skills you write in your workspace, such as how you cut a release | Coming |
| Skills from the [Marketplace](/guides/marketplace/) | Coming |
| Skills an agent proposes from finished work, published after a person reviews them | Coming |

They will work the same way: a playbook that uses only the tools the agent
already has.
