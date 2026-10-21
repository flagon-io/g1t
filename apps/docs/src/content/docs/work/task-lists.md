---
title: Task lists
description: Write a checklist in a work item's or pull request's description with `- [ ]`, and tick its boxes on the page, from the CLI or over MCP. Only the box you tick changes, so two people ticking different boxes at once both keep theirs.
---

A **task list** is a checklist in a description: each list item that
starts with `[ ]` is a box, and `[x]` is a ticked one. Use one for the
steps of a work item, or for what a pull request still needs before it
merges.

```md
- [x] Add `--filter` to clone
  - [x] Tests for `blob:none`
- [ ] Document the new flag
- [ ] Announce it
```

Task lists work in a work item's description and in a pull request's.
Boxes can be nested, numbered (`1. [ ]`) or in a quote. A `- [ ]` in a
code block is an example, not a box.

For a work item's progress across several work items, rather than steps
within one, use [sub-items](/work/sub-items/).

## Tick a box

**On the page**, click a box. It shows ticked at once and is saved as
you click, so you can tick several in a row. Whoever may edit the
description may tick its boxes:

- on a work item, its owner, or anyone with the Triage role on it;
- on a pull request, its author, or anyone with the Triage role in its
  repository. A merged or closed pull request's boxes can still be ticked,
  since a checklist is often finished after the merge.

Anyone else sees the boxes but can't click them.

**From the CLI**, `g1t work check` and `g1t pr check` name the box by its
number or by words of its text, and `--uncheck` unticks it:

```sh
g1t work check 195 2                    # tick the second box of #195
g1t work check 195 "document"           # tick the box that says "document"
g1t work check 195 2 --uncheck          # untick it again
g1t pr check 253 1                      # the first box of pull request #253
g1t work check 195 2026 --text          # a box whose text is a number
```

Boxes are numbered from 1 in the order they're written, nested ones
included, so in the list above **Document the new flag** is box 3. Words
of its text name the box that says exactly that, ignoring case and
spacing, or else the one box whose text contains them. When more than one
box does, g1t names them and ticks none:
`2 boxes say "write": 1 Write the docs; 2 Write the tests. Give more of its text, or its number.`

The command says which box it ticked and how many are done:

```text
✓ Ticked box 3 of acme#195: Document the new flag (3 of 4 done)
```

`g1t pr check` ticks a box; `g1t pr checks` is something else, the
workflow checks of a pull request.

**Over MCP**, the `work_item` and `pull_request` tools' `check` action,
with `task` (the box's number) or `text`, and `checked` `false` to untick.
**Over the API**,
[`PATCH /workspaces/{workspace}/work/{number}/tasks`](/reference/api/work-items/check-work-item-task/)
and
[`PATCH /repos/{owner}/{name}/pulls/{number}/tasks`](/reference/api/pull-requests/check-pull-request-task/):

```sh
curl -X PATCH https://api.g1t.sh/workspaces/acme/work/195/tasks \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task": 3, "expected": "Document the new flag"}'
```

Each answers with the box (`number`, `line`, `text` and `checked`),
whether it `changed`, the `body` after, and how many boxes are `done` of
the `total`. A box that already is as asked is left alone, with `changed`
`false`. They need the `work:write` and `pull_requests:write` scopes.

## When two people tick at once

g1t never saves a whole description to tick one box. It changes only the
character between that box's brackets, in the description as it is at
that moment. If someone else changed the description in between, such as
by ticking another box, g1t reads it again and ticks your box in that, so
neither change is lost.

A box is named by its number, and a number can move: when someone adds or
removes a box above it, box 3 becomes box 4. So the page, and any caller
that gives `expected` (the box's text as it read it), say what the box
said as well. g1t then ticks the box that says that, wherever it is now.
When no box, or more than one, says it any more, the tick is refused with
`409` rather than ticking the wrong box. On the page, the box goes back,
the reason shows under the description, and the description is shown as
it is now, to tick again.

## Edit the whole description

To rewrite a description rather than tick a box, read it, change it and
write it back. `g1t work view --json body` gives a work item's description,
which `g1t work edit --body-file` writes:

```sh
g1t work view 195 --json body --jq .body > body.md
# edit body.md
g1t work edit 195 --body-file body.md
```

That replaces the whole description, so a box someone ticks in between is
lost: tick boxes with `check` instead.
