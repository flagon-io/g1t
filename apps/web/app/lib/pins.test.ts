import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_RECENT, movedPin, pinFromForm, recentWith } from "./pins.ts";

const p = (name: string, namespace = "acme") => ({ namespace, name, isPrivate: false });
const names = (list: { name: string }[]) => list.map((project) => project.name);

test("the project being looked at leads recent, once", () => {
  assert.deepEqual(names(recentWith([p("a"), p("b")], [], p("c"), "acme")), ["c", "a", "b"]);
  assert.deepEqual(names(recentWith([p("a"), p("b")], [], p("b"), "acme")), ["b", "a"]);
});

test("pinned projects are never also recent", () => {
  assert.deepEqual(names(recentWith([p("a"), p("b")], [p("a")], p("b"), "acme")), ["b"]);
  assert.deepEqual(names(recentWith([p("a")], [p("c")], p("c"), "acme")), ["a"]);
});

test("another workspace's project is not this one's recent", () => {
  assert.deepEqual(names(recentWith([p("a")], [], p("x", "other"), "acme")), ["a"]);
  assert.deepEqual(names(recentWith([p("a")], [], p("x"), null)), ["a"]);
});

test("recent holds a few", () => {
  const many = Array.from({ length: 9 }, (_, i) => p(`r${i}`));
  assert.equal(recentWith(many, [], p("now"), "acme").length, MAX_RECENT);
});

test("a pin form says what to change", () => {
  const form = (entries: [string, string][]) => {
    const data = new FormData();
    for (const [key, value] of entries) data.append(key, value);
    return data;
  };
  assert.deepEqual(pinFromForm(form([["intent", "pin"], ["slug", " Web "]])), { intent: "pin", slug: "web", position: null });
  assert.deepEqual(pinFromForm(form([["intent", "pin"], ["slug", "web"], ["position", "2"]])), { intent: "pin", slug: "web", position: 2 });
  assert.deepEqual(pinFromForm(form([["intent", "unpin"], ["slug", "web"]])), { intent: "unpin", slug: "web" });
  assert.deepEqual(pinFromForm(form([["intent", "reorder"], ["slug", "b"], ["slug", "a"]])), { intent: "reorder", slugs: ["b", "a"] });
  assert.equal(pinFromForm(form([["intent", "reorder"], ["slug", "a"], ["slug", "a"]])), null);
  assert.equal(pinFromForm(form([["intent", "pin"]])), null);
  assert.equal(pinFromForm(form([["intent", "star"], ["slug", "web"]])), null);
});

test("a pin moves up or down within the list", () => {
  assert.deepEqual(movedPin(["a", "b", "c"], 2, -1), ["a", "c", "b"]);
  assert.deepEqual(movedPin(["a", "b", "c"], 0, 1), ["b", "a", "c"]);
  assert.equal(movedPin(["a", "b", "c"], 0, -1), null);
  assert.equal(movedPin(["a", "b", "c"], 2, 1), null);
});
