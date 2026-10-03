---
title: Automations
description: Rules committed to a repository that act when something happens, such as commenting, labelling, putting an agent on an issue or posting to chat.
---

An automation is a rule kept in the repository, in
`.g1t/automations/`. It says what starts it, what must be true, and the
steps to take:

```yaml
# .g1t/automations/bugs.yml
name: Put an agent on every bug
on: issue.opened
if:
  labels: bug
do:
  - comment: "Thanks, {{actor}}. A g1t agent is on it."
  - assign_agent
```

Commit that file to the default branch and, from the next issue opened
with the label `bug`, g1t answers it and starts an agent on it. Change or
delete the file and the automation changes with it.

Because automations are files, they are reviewed in pull requests like
any other change. Each repository can have up to 50.

## See them run

Open the repository's **Automations** page, in its sidebar. Each automation
is listed in words, such as *On issue.opened, if labelled bug: comment,
then put a g1t agent on it*, with its last run. A file g1t cannot read is
listed too, with what is wrong with it.

**Recent runs** lists the last 50 runs. Open a run to see what started it,
and either how each step went or why the run was skipped.

Members of the workspace can also:

- **Run now**: run it straight away, on an issue or pull request if you
  give its number. This works for any automation, whatever starts it.
- **Turn off** and **Turn on**: stop it without changing its file. It
  stays off when the file changes.

## What starts it: `on`

| `on` | Starts it |
| --- | --- |
| An event, such as `issue.opened` | Whenever that happens in the repository. |
| A list, such as `[pull.merged, pull.closed]` | Whenever any of them happens. |
| `schedule: "0 9 * * mon"` | On a cron schedule, in UTC. |
| `manual` | Only by **Run now** or the API. |

The events are the same as [webhooks'](/guides/webhooks/#events):

| Event | When |
| --- | --- |
| `git.push` | A branch moved. |
| `issue.opened`, `issue.updated`, `issue.assigned`, `issue.closed`, `issue.reopened` | An issue changed. |
| `comment.created` | A comment or review on an issue or pull request. |
| `pull.opened`, `pull.ready`, `pull.updated`, `pull.merge_requested`, `pull.merged`, `pull.closed` | A pull request changed. |
| `checks.completed` | An issue's acceptance checks finished on a pull request. |
| `review.completed` | A g1t agent reviewed a pull request. |
| `queue.changed` | The merge queue changed. |

A schedule has five fields: minute, hour, day of the month, month and day
of the week. Each field takes `*`, a number, a list (`1,15`), a range
(`1-5`) or a step (`*/15`, `0-30/10`). Days of the week also take names,
`sun` to `sat`.

| Schedule | Runs |
| --- | --- |
| `"0 9 * * mon"` | Mondays at 09:00 UTC |
| `"*/30 * * * *"` | Every half hour |
| `"0 0 1 * *"` | At midnight on the first of each month |
| `"0 17 * * mon-fri"` | Weekdays at 17:00 UTC |

A scheduled run is not about any issue or pull request, so it can only use
`open_issue` and `notify`.

## Conditions: `if`

`if` maps fields to the values they must have. Give one value or a list:
any value in the list matches. Every field must match. Matching ignores
case.

```yaml
if:
  labels: [bug, regression]   # has either label
  status: failed              # checks.completed's data.status
  actor: ada                  # caused by ada
```

| Field | Matches |
| --- | --- |
| `labels` | The issue has any of these labels. For a pull request, the labels of its issue. |
| `actor` | The username of who caused the event. A g1t agent is `g1t-agent`. |
| `branch` | The branch pushed to, for `git.push`. |
| Any field of the event's `data` | Such as `status` or `verdict`. Write `data.status` to be explicit. |

When the conditions do not match, the run is recorded as skipped, with the
reason, such as *not labelled bug*.

## Steps: `do`

Steps run in order. When a step fails, the steps after it do not run, and
the run shows which step failed and why.

| Step | Does |
| --- | --- |
| `comment: text` | Comments on the issue or pull request. |
| `label: name` | Adds a label to the issue. |
| `unlabel: name` | Removes a label from the issue. |
| `assign_agent` | Puts a g1t agent on the issue, which opens a pull request. |
| `message_agent: text` | Tells the agent working on the pull request. It reads the message at its next step. |
| `close_issue` | Closes the issue as completed. `close_issue: not_planned` closes it as not planned. |
| `reopen_issue` | Reopens the issue. |
| `open_issue:` | Opens a new issue: `title`, and optionally `body`, `labels` and `assign_agent: true`. |
| `notify:` | Posts `text` to an HTTPS `url`, such as a Slack or Discord incoming webhook. |

A step without arguments is written as its name alone, such as
`- assign_agent`. A step that takes text is written as the name and the
text, such as `- label: triaged`. A step that takes several arguments takes
a mapping:

```yaml
do:
  - open_issue:
      title: Weekly tidy-up
      body: Update dependencies that have new patch releases.
      labels: [chore]
      assign_agent: true
  - notify:
      url: https://hooks.slack.com/services/T000/B000/XXXX
      text: "Opened #{{opened}} in {{repo}}"
```

`notify` sends `{"text": …, "content": …}`, the shape that Slack's,
Discord's and most chat tools' incoming webhooks take. It posts only to
public addresses.

## Filling in text: `{{ }}`

Text in steps can use these, written in double braces:

| Name | Is |
| --- | --- |
| `{{repo}}` | The repository, such as `acme/web`. |
| `{{event}}` | What started the run, such as `issue.opened`, `schedule` or `manual`. |
| `{{automation}}` | The automation's name. |
| `{{actor}}` | The username of who caused the event. |
| `{{number}}`, `{{title}}`, `{{url}}` | The issue or pull request the event is about. |
| `{{branch}}` | The branch pushed to, for `git.push`. |
| `{{opened}}` | The number of the issue that `open_issue` just opened. |
| `{{data.field}}` | Any field of the event's data, such as `{{data.status}}`. |

A name with no value is left empty.

## Who it acts as

An automation acts as its workspace. A comment from one shows the
workspace as its author and ends with the automation's name. An agent
it starts is billed to the workspace like any other run, through the
workspace's [model providers](/guides/models/).

## The rules every run keeps

- **Once per event.** An event runs each automation at most once, even if
  it is delivered again.
- **No loops.** An automation does not answer an event that its own run
  caused on the same issue or pull request in the last 10 minutes. An
  automation that labels issues on `issue.updated` does not keep running
  because it labelled one.
- **A limit per hour.** An automation makes at most 30 runs an hour.
  Runs past the limit are skipped and recorded. Change the limit, up to
  200, with:

  ```yaml
  limits:
    per_hour: 100
  ```

## More examples

Tell the agent when checks fail:

```yaml
name: Tell the agent when checks fail
on: checks.completed
if:
  status: failed
do:
  - message_agent: "The acceptance checks failed. Read their output on #{{number}} and fix the cause."
```

Announce merges in chat:

```yaml
name: Announce merges
on: pull.merged
do:
  - notify:
      url: https://hooks.slack.com/services/T000/B000/XXXX
      text: "Merged into {{repo}}: {{title}} {{url}}"
```

Close questions nobody followed up:

```yaml
name: Close answered questions
on: manual
if:
  labels: question
do:
  - comment: "Closing this as answered. Reopen it if there is more to ask."
  - close_issue: not_planned
```

## From the API

| Tool | Route |
| --- | --- |
| `list_automations` | `GET /repos/{owner}/{name}/automations` |
| `list_automation_runs` | `GET /repos/{owner}/{name}/automations/runs`, optionally `?automation={id}` |
| `run_automation` | `POST /repos/{owner}/{name}/automations/{id}/runs`, optionally with `number` |
| `update_automation` | `PATCH /repos/{owner}/{name}/automations/{id}` with `enabled` |

Running an automation or turning one on or off needs a member of the
workspace. Agents cannot run or change automations. To add or change one,
commit its file.

```sh
curl -X POST https://api.g1t.sh/repos/acme/web/automations/aut_01m4…/runs \
  -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
  -d '{"number": 42}'
```
