import { test } from "node:test";
import assert from "node:assert/strict";

import { ACTIVE, decayed, raised } from "./activity.ts";

const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(Date.UTC(2026, 9, 1) + days * DAY).toISOString();

test("a first piece of activity scores one", () => {
  assert.deepEqual(raised(0, null, at(0)), { score: 1, at: at(0) });
});

test("activity counts half as much a week later", () => {
  assert.equal(decayed(4, at(0), at(7)), 2);
  assert.equal(decayed(4, at(0), at(14)), 1);
  assert.equal(raised(4, at(0), at(7)).score, 3);
});

test("a busy project outranks one busy long ago", () => {
  let busyThen = { score: 0, at: null as string | null };
  for (let i = 0; i < 20; i++) busyThen = raised(busyThen.score, busyThen.at, at(0));
  let busyNow = { score: 0, at: null as string | null };
  for (let i = 0; i < 5; i++) busyNow = raised(busyNow.score, busyNow.at, at(40));
  assert.ok(decayed(busyNow.score, busyNow.at, at(41)) > decayed(busyThen.score, busyThen.at, at(41)));
});

test("an event delivered late never moves the time back", () => {
  const next = raised(2, at(5), at(3));
  assert.equal(next.at, at(5));
  assert.equal(next.score, 3);
});

test("nonsense counts as nothing", () => {
  assert.equal(decayed(3, "not a time", at(0)), 0);
  assert.equal(decayed(-1, at(0), at(1)), 0);
});

test("pushes, work and deployments count; housekeeping does not", () => {
  assert.ok(ACTIVE.has("git.push"));
  assert.ok(ACTIVE.has("pull.merged"));
  assert.ok(!ACTIVE.has("repo.created"));
});
