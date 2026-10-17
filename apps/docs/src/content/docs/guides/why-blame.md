---
title: Sessions and why-blame
description: How g1t records the way a change was made, and how to find out why any line is the way it is.
---

Blame tells you who last changed a line. On g1t it also tells you why: the pull request the line arrived in, the work item that asked
for it, and, when a coding agent wrote it, the agent's own account of what it did.
That comes from **sessions**, the record of how each pull request was made.

## Sessions

A pull request's session records how the change was made, entry by entry,
as it happens. Entries come from `record_session` on the pull request, and
from any [harness session](/guides/sessions/#sessions) attached to it:

| Kind | What it holds |
| --- | --- |
| `prompt` | What the agent was asked to do, and messages people sent it while it worked. |
| `message` | The agent's own reasoning and explanation. |
| `tool_call` | A tool the agent ran, and with what input. |
| `tool_result` | What the tool returned. |
| `note` | Anything else worth keeping, such as what the agent was told about other work in progress. |

Each entry is stored with the head commit of the pull request at the time
it was recorded. That link is what lets g1t show the reasoning behind a
commit rather than only the commit.

Read a session on the pull request's **Session** tab, with the
`pull_request` tool's `read_session` action,
or with `GET /repos/{owner}/{name}/pulls/{number}/session?after=`.
Outside the workspace only g1t's notes show there, and members see a
prompt or a tool's output only when it is their own; what looks like a
credential is taken out of all of it
([Who sees what](/guides/sessions/#who-sees-what)). Still, do not put
secrets in one.

### Recording a session

Your coding agent records its session in one of two ways.

**With g1t's Claude Code plugin.** Every session is recorded without the
agent having to remember:

```sh
claude plugin marketplace add https://g1t.sh/flagon-io/g1t-plugins.git
claude plugin install g1t@g1t
```

See [Claude Code plugin](/guides/claude-code-plugin/) for what it records,
what it never records and how to opt out.

**With the `pull_request` tool's `record_session` action**, from any agent. It takes a list of entries, each
with a `kind` from the table above and `text`, and `tool` for tool entries.
The same is `POST /repos/{owner}/{name}/pulls/{number}/session`, with up to
200 entries per request:

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/pulls/14/session \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entries": [
        {"kind": "prompt", "text": "Make the greeting name the caller."},
        {"kind": "tool_call", "tool": "Edit", "text": "src/main.rs"},
        {"kind": "message", "text": "Took the name from the first argument, falling back to world."}
      ]}'
```

Record as you work, not only at the end: an entry is tied to the commit
that was the head when it was recorded, so recording before each push is
what lets why-blame find the reasoning behind each commit.

## Why a line is the way it is

Every file can be shown with **Blame**: beside each run of lines, the commit
that last changed it.

1. Open a file in the repository's **Code** tab.
2. Choose **Blame**.
3. Pick a line.

g1t then shows why the line is the way it is:

- the commit that last changed it;
- the pull request it arrived in, and who or what wrote it and merged it;
- the work item that asked for it, with its description;
- how it was decided: the [decision records](#decision-records) on the
  work item and every pull request for it, oldest first, each marked
  **Claimed**, **Tested** or **Approved**. A combination that failed in
  the merge queue is shown first, with the pull requests tested together,
  the check that failed and the fix that answered it; then the
  proposals, the fix, the approval and the merge;
- when a coding agent wrote it, the agent's own account of the change and the
  commands it ran, taken from its session. The steps shown are from the
  work that produced that commit: the agent's messages, and the tool calls
  that touched the file.

Blame follows every parent of a merge, so a line that came into a pull
request when it caught up with `main` is credited to whoever wrote it on
`main`, not to the merge.

Blame reads up to 400 commits back, for up to six seconds. A line older
than that is credited to the oldest commit read that has it, and the view
says the history is long. While it is worked out the file shows as it is,
with "Working out who changed each line" above it, and each line's commit
fills in when it is ready. A file's blame at a commit is kept once worked
out, so opening it again, or from a commit's link, shows at once. Search
engines and other crawlers are asked to leave blame pages alone
(`Disallow: /*?blame=`, and `/*/*/blame/` for the blame data the view
fetches, in `/robots.txt`); the file itself stays open to them.

### Why over the API

The `repository` tool's `why` action, or
`GET /repos/{owner}/{name}/why?path=&line=&ref=`, answers the same for one
line, with the decision records too. `ref` is a branch, tag or commit; the
default branch when left out.

```sh
curl "https://api.g1t.sh/repos/acme/web/why?path=src/config.rs&line=42" \
  -H "Authorization: Bearer $G1T_TOKEN"
```

| Field | |
| --- | --- |
| `commit` | The commit that last changed the line: `hash`, `message`, `author` (`name` as git wrote it, and `username`, the g1t account the author's address belongs to, when one does; never the address), `parents`, `authored_at`. |
| `pull` | The merged pull request it arrived in: `number`, `title`, `author`, `agent`, `merged_by`, `merged_at`. Absent when it did not arrive through one. |
| `item` | That pull request's work item: `workspace`, `number`, `title`, `state` and `body` (cut at 900 characters). |
| `decisions` | The [decision records](#decision-records) on the pull request, oldest first. |
| `sessions` | Up to eight entries of the pull request's session behind that commit: the messages, and the tool calls that touched the file. |

A pull request is found for a commit as on the site: the one whose head it
is, or the one whose stretch of the default branch's last 300 commits holds
it. It is public for a public repository, and needs the `code:read` scope
otherwise.

## Decision records

A decision record is a reason kept on a work item or pull request, with how
sure it is. Sessions say what happened; decisions say why the result is
the way it is, in a sentence, with what it rests on.

| Confidence | Meaning |
| --- | --- |
| `claimed` | Someone said so: an agent or a person recorded it. |
| `tested` | A check or the merge queue proved it. |
| `approved` | A person approved it. |

g1t keeps these itself:

| Kind | When | Confidence |
| --- | --- | --- |
| `integration_failure` | The [merge queue](/guides/merge-queue/#when-an-entry-fails) found a combination of pull requests fails: which ones, and the check. | `tested` |
| `integration_passed` | A combined state passed in the merge queue. | `tested` |
| `approval` | Someone approved the pull request. | `approved` for a person, `claimed` for an agent's token |
| `merge` | It was merged. | `tested` through the queue or a repository's own auto-merge, `approved` when a person merged it, `claimed` for an agent's token |

Agents and people record their own, of kind `proposal` (why the change is
made this way), `claim` (something true of it), `fix` (what fixed a
failure) or `note`, always as `claimed`, with the `pull_request` tool's
`record_decision` action or
`POST /repos/{owner}/{name}/pulls/{number}/decisions`:

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/pulls/14/decisions \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind": "fix",
       "summary": "Renamed the config key #12 also introduced, so both read retry_limit.",
       "evidence": {"commit": "7d3e9a1c"}}'
```

`summary` is at most 2,000 characters and `evidence` an object of at most
8 KB. Whoever opened the pull request can record one, and so can anyone
who may comment on it, once their email address is confirmed. Each is
attributed to whoever recorded it, carries
the work item the pull request is for, and is published as `decision.recorded`.

A pull request's **Session** tab lists its decisions above what was
recorded, with the harness sessions working on it; a work item lists its
own and its pull requests' under them, from every repository it links.

Read them with the `pull_request` tool's `list_decisions` action, with
`GET /repos/{owner}/{name}/pulls/{number}/decisions`, or for a work item
and all its pull requests in its `decisions`, from `g1t work view` or
[`GET /workspaces/{workspace}/work/{number}/work`](/reference/api/work-items/get-work/).
A decision is as visible as the repository, so do not put secrets in one.

## Commit pages

Every commit has a page of its own, `g1t.sh/<workspace>/<repo>/commit/<hash>`,
with its diff, its parents and the pull request it arrived in. The
repository's **Commits** tab lists them.
