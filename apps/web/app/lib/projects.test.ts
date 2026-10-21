import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkItem, WorkProject } from "@g1t/contracts";

import {
  datesText,
  dayText,
  healthTone,
  hillCounts,
  hillDots,
  hillY,
  isLive,
  percentDone,
  projectChangeOf,
  projectGroups,
  projectPath,
  projectsPath,
  sidebarProjects,
  timeElapsed,
  timeLeft,
} from "./projects.ts";

const project = (name: string, state: WorkProject["state"], archivedAt: string | null = null) => ({ name, state, archivedAt });
const item = (number: number, horizon: WorkItem["horizon"] = "now") => ({ number, horizon }) as WorkItem;
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const today = new Date("2026-10-21T15:00:00Z");

test("a project's pages are under Work", () => {
  assert.equal(projectsPath("Acme"), "/acme/-/work/projects");
  assert.equal(projectsPath("acme", "new=1"), "/acme/-/work/projects?new=1");
  assert.equal(projectPath("acme", "work-overhaul"), "/acme/-/work/projects/work-overhaul");
  assert.equal(projectPath("acme", "work-overhaul", "items"), "/acme/-/work/projects/work-overhaul/items");
});

test("the sidebar lists live projects, active first, each by name", () => {
  const listed = sidebarProjects([
    project("Zeta", "active"),
    project("Beta", "paused"),
    project("Alpha", "active"),
    project("Gamma", "shaping"),
    project("Done", "done"),
    project("Old", "active", "2026-10-01T00:00:00Z"),
  ]);
  assert.deepEqual(
    listed.map((p) => p.name),
    ["Alpha", "Zeta", "Gamma", "Beta"],
  );
  assert.ok(isLive(project("A", "paused")));
  assert.ok(!isLive(project("A", "dropped")));
  const { live, finished } = projectGroups([project("B", "done"), project("A", "active"), project("C", "dropped")]);
  assert.deepEqual(
    live.map((p) => p.name),
    ["A"],
  );
  assert.deepEqual(
    finished.map((p) => p.name),
    ["B", "C"],
  );
});

test("dates read as people read them", () => {
  assert.equal(dayText("2026-12-12", 2026), "Dec 12");
  assert.equal(dayText("2027-01-04", 2026), "Jan 4, 2027");
  assert.equal(datesText({ startOn: "2026-10-20", targetOn: "2026-12-12" }, today), "Oct 20 → Dec 12");
  assert.equal(datesText({ startOn: null, targetOn: "2026-12-12" }, today), "Due Dec 12");
  assert.equal(datesText({ startOn: null, targetOn: null }, today), null);
  assert.deepEqual(timeLeft({ targetOn: "2026-10-31", state: "active" }, today), { text: "10 days left", late: false });
  assert.deepEqual(timeLeft({ targetOn: "2026-12-12", state: "active" }, today), { text: "7 weeks left", late: false });
  assert.deepEqual(timeLeft({ targetOn: "2026-10-21", state: "active" }, today), { text: "Due today", late: false });
  assert.deepEqual(timeLeft({ targetOn: "2026-10-18", state: "paused" }, today), { text: "3 days late", late: true });
  // A finished project has no time left to count.
  assert.equal(timeLeft({ targetOn: "2026-10-18", state: "done" }, today), null);
  assert.equal(timeElapsed({ startOn: "2026-10-11", targetOn: "2026-10-31" }, new Date("2026-10-21T00:00:00Z")), 50);
  assert.equal(timeElapsed({ startOn: null, targetOn: "2026-10-31" }, today), null);
});

test("progress and health read from the record", () => {
  assert.equal(percentDone({ openItems: 13, closedItems: 11 }), 45);
  assert.equal(percentDone({ openItems: 0, closedItems: 0 }), 0);
  assert.equal(healthTone("at_risk"), "warn");
  assert.equal(healthTone(null), "neutral");
});

test("each open work item sits in its stage's quarter of the hill, none on another", () => {
  const open = [item(1), item(2), item(3), item(4, "next")];
  const dots = hillDots(open, [
    { number: 1, hill: "building" },
    { number: 2, hill: "building" },
    { number: 3, hill: "landing" },
  ]);
  // #4 has no progress: it is still being figured out.
  assert.deepEqual(
    dots.map((dot) => [dot.item.number, dot.hill]),
    [
      [4, "figuring_out"],
      [1, "building"],
      [2, "building"],
      [3, "landing"],
    ],
  );
  const building = dots.filter((dot) => dot.hill === "building").map((dot) => dot.x);
  assert.ok(
    building.every((x) => x > 160 && x < 234),
    "building is the third quarter, past the top",
  );
  assert.notEqual(building[0], building[1]);
  for (const dot of dots) assert.equal(dot.y, Math.round(hillY(dot.x) * 10) / 10);
  assert.equal(hillY(160), 16);
  assert.deepEqual(hillCounts(dots), { figuring_out: 1, decided: 0, building: 2, landing: 1 });
});

test("a project's form posts only the fields it has", () => {
  assert.deepEqual(projectChangeOf(form({ health: "at_risk" })), { health: "at_risk" });
  assert.deepEqual(projectChangeOf(form({ health: "" })), { health: null });
  assert.deepEqual(projectChangeOf(form({ name: " Work overhaul ", targetOn: "2026-12-12", appetite: "large" })), {
    name: "Work overhaul",
    targetOn: "2026-12-12",
    appetite: "large",
  });
  assert.equal(projectChangeOf(form({ name: " " })), "A project needs a name.");
  assert.equal(projectChangeOf(form({ health: "fine" })), "Choose a health: on track, at risk or off track.");
  assert.equal(projectChangeOf(form({ startOn: "2026-12-12", targetOn: "2026-10-01" })), "The target date can't be before the start date.");
  assert.deepEqual(projectChangeOf(form({ brief: "## Problem\n" })), { brief: "## Problem\n" });
});
