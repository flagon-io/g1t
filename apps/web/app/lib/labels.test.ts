import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chipStyle,
  colorsOf,
  dayInWords,
  dueInWords,
  isOverdue,
  listFilters,
  matchLabels,
  percentDone,
  tidyColor,
  tidyLabelName,
  withFilter,
} from "./labels.ts";

test("colors are six hex digits however they were written", () => {
  assert.equal(tidyColor("#D73A4A"), "d73a4a");
  assert.equal(tidyColor("fc0"), "ffcc00");
  assert.equal(tidyColor("red"), null);
  assert.equal(tidyColor(undefined), null);
});

test("a chip is tinted with its label's color, and neutral without one", () => {
  const style = chipStyle("d73a4a");
  assert.match(style.backgroundColor!, /#d73a4a/);
  assert.match(style.color!, /var\(--color-fg\)/);
  assert.deepEqual(chipStyle("nope"), {});
  assert.deepEqual(colorsOf([{ name: "bug", color: "d73a4a" }]), { bug: "d73a4a" });
});

test("labels are found by name or description", () => {
  const labels = [
    { name: "bug", description: "Something isn't working" },
    { name: "good first issue", description: "Good for newcomers" },
  ];
  assert.deepEqual(matchLabels(labels, "first").map((l) => l.name), ["good first issue"]);
  assert.deepEqual(matchLabels(labels, "working").map((l) => l.name), ["bug"]);
  assert.equal(matchLabels(labels, "  ").length, 2);
  assert.equal(tidyLabelName("  Good   First Issue "), "good first issue");
});

test("a milestone's progress and due date read as words", () => {
  assert.equal(percentDone({ openItems: 3, closedItems: 1 }), 25);
  assert.equal(percentDone({ openItems: 0, closedItems: 0 }), 0);
  assert.equal(dayInWords("2026-10-14"), "October 14, 2026");
  const today = new Date("2026-10-07T12:00:00Z");
  assert.equal(dueInWords({ dueOn: "2026-10-14", state: "open" }, today), "Due by October 14, 2026");
  assert.equal(dueInWords({ dueOn: "2026-10-05", state: "open" }, today), "Past due by 2 days");
  assert.equal(dueInWords({ dueOn: "2026-10-05", state: "closed" }, today), "Due by October 5, 2026");
  assert.equal(dueInWords({ dueOn: null, state: "open" }, today), null);
  assert.equal(isOverdue({ dueOn: "2026-10-05", state: "open" }, today), true);
  assert.equal(isOverdue({ dueOn: "2026-10-07", state: "open" }, today), false);
});

test("filters come from the address, and q wins", () => {
  const plain = listFilters(new URLSearchParams("label=Bug&milestone=3&state=closed"));
  assert.deepEqual(plain, { label: "bug", milestone: 3, state: "closed", base: "" });
  const typed = listFilters(new URLSearchParams({ q: 'label:"good first issue" milestone:2 is:open base:release' }));
  assert.deepEqual(typed, { label: "good first issue", milestone: 2, state: "open", base: "release" });
  assert.deepEqual(listFilters(new URLSearchParams()), { label: "", milestone: null, state: "open", base: "" });
});

test("changing one filter keeps the others", () => {
  const current = new URLSearchParams("state=closed&label=bug");
  assert.equal(withFilter("/a/b/issues", current, "milestone", "3"), "/a/b/issues?state=closed&label=bug&milestone=3");
  assert.equal(withFilter("/a/b/issues", current, "label", null), "/a/b/issues?state=closed");
  assert.equal(withFilter("/a/b/issues", new URLSearchParams("label=bug"), "label", ""), "/a/b/issues");
});
