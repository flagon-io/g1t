---
title: Sub-items
description: Break a work item down into sub-items. A work item has one parent and any number of sub-items in its workspace; a parent shows how many of them are done, and closing it never closes them silently.
---

A big piece of work rarely lands in one pull request. Break it down: each
part becomes a work item of its own, a **sub-item** of the work item it is
part of, its **parent**. The parent keeps the grouping and shows how far
along its sub-items are, such as **3 of 7 done**, while each sub-item is
planned, claimed, worked on and closed on its own.

- A work item has at most one parent and any number of sub-items.
- Parent and sub-items are work items of the same workspace, in any of its
  repositories.
- A sub-item can have sub-items of its own. g1t refuses a cycle: a work
  item can't be put under itself, or under one of its own sub-items.
- A parent is not [blocked by](/work/claims-and-dependencies/#dependencies)
  its sub-items, nor a sub-item by its parent. Say so with `blocked_by`
  when one really has to land first.

## Make a sub-item

On a work item's page, its owner, or someone with the Triage role on it,
can:

- set or clear its parent: **Edit** beside **Sub-item of** in the Work
  panel (an empty field clears it);
- add a sub-item: **Add sub-item** under **Sub-items**, by its number, or
  **Open a new one** to file a new work item under it;
- take a sub-item out, with the button on its row.

Filing a new work item, **Sub-item of** takes its parent's number.

From the CLI:

```sh
g1t work new --title "Clone cache keeps a pack" --parent 212
g1t work edit 228 --parent 212
g1t work edit 228 --remove-parent
```

Over MCP, the `work_item` tool's `parent`, `add_sub_item` and
`remove_sub_item` actions; over the API,
[`PUT /workspaces/{workspace}/work/{number}/parent`](/reference/api/work-items/set-work-item-parent/),
[`POST /workspaces/{workspace}/work/{number}/sub_items`](/reference/api/work-items/add-work-item-sub-item/)
and
[`DELETE /workspaces/{workspace}/work/{number}/sub_items/{sub_item}`](/reference/api/work-items/remove-work-item-sub-item/):

```sh
curl -X PUT https://api.g1t.sh/workspaces/acme/work/228/parent \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"parent": 212}'
```

`parent` `null` takes it out of its parent. Filing a work item with
`parent`, and `update_work_item` with `parent`, do the same. A parent you
can't see, the work item itself, or one of its own sub-items is refused
with `422`, which names the chain:
`#212 is already under #230 (#212 → #219 → #230, each a sub-item of the next), so #230 cannot be its sub-item.`

Changing a parent needs what changing the sub-item does: being its owner,
or the Triage role on it. Each change is noted in the conversations of the
sub-item and of each parent it left or joined.

## What a parent shows

- **Its page** lists its sub-items, each with its state, and how many are
  done. **Done** means closed, as completed or as not planned.
- **Lists, the Board and the plan** show `3/7` beside a parent's title.
- **A sub-item** shows `↑ #212` beside its title, linking back, and its
  page says what it is a sub-item of.

Every work item carries `parent` (its parent's number) and, when it has
sub-items, `sub_item_progress` (`done` of `total`).
[`get_work_item`](/reference/api/work-items/get-work-item/) and
[`get_work`](/reference/api/work-items/get-work/) add `parent` and
`sub_items`, each with its number, title and state: those you can see.

## Find the sub-items

- On [Work](/work/), filter by `parent:212` (or open `-/work/all?parent=212`).
- In [search](/guides/search/), `parent:212` (or `parent:#212`) finds the
  work items whose parent is #212. Add `org:` to keep to one workspace:
  #212 of each workspace you can see is searched otherwise.
- `g1t work list --parent 212`, or `list_work_items` with `parent`.

## Close a parent

Closing a work item never closes its open sub-items silently. While it has
some, closing it asks what to do with them:

| Choice               | What happens                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Leave them open      | They stay open, still its sub-items.                                                                                     |
| Close them too       | They close with the same reason, and so do their own open sub-items. You need to be able to close each one.              |
| Move them to another | They become sub-items of the work item you name, which mustn't be under any of them. They move before the parent closes. |

Over the API and MCP, `close_work_item` takes `sub_items` (`leave`,
`close` or `move`) and, with `move`, `move_to`. Without `sub_items`, a
work item with open sub-items is refused with `409`, naming them. From
the CLI, `g1t work close` asks at a terminal; elsewhere give
`--sub-items` (and `--move-to`).

A commit or a merged pull request that closes a parent
([closing keywords](/work/closing/#closing-keywords)) leaves its
sub-items open.

## When the last sub-item closes

Closing the last open sub-item does not close its parent. The parent's
conversation says so (**closed #234, the last open sub-item: all 7
sub-items are done. This stays open until someone closes it.**), and
whoever owns it decides: there may be work left that no sub-item names.

## Sub-items and the plan

Each sub-item has its own place in the [plan](/work/plan/). Moving a
sub-item to another horizon doesn't move its parent, and moving a parent
doesn't move its sub-items. The plan can show sub-items grouped under
their parent: see [the plan](/work/plan/#sub-items-in-the-plan).

Triage closes as not planned without asking: a work item there with open
sub-items is refused, naming them. Close it from its page instead.

## Events

| Event                         | When                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `work_item.parent_changed`    | On the sub-item: it became a sub-item of another work item, or stopped being one. `parent` is its parent now (left out for none), `from_parent` the one it had.           |
| `work_item.sub_items_changed` | On the parent: a sub-item was `added`, `removed`, `closed` or `reopened` (`change`), with `sub_item`, its number, and `progress`, how many of its sub-items are done now. |

[Webhooks](/guides/webhooks/) deliver both, and a parent's page updates
live when one of its sub-items changes.
