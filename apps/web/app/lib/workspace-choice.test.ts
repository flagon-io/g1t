import assert from "node:assert/strict";
import { test } from "node:test";

import { readCookie } from "./mission.ts";
import { chosenWorkspace, forgetWorkspace, rememberWorkspace, workspaceFor } from "./workspace-choice.ts";

const mine = [{ slug: "flagon-io" }, { slug: "syntaqx" }];

test("the chosen workspace holds while you are a member, else the first", () => {
  assert.equal(chosenWorkspace(mine, "syntaqx")?.slug, "syntaqx");
  assert.equal(chosenWorkspace(mine, "SYNTAQX")?.slug, "syntaqx");
  assert.equal(chosenWorkspace(mine, "someone-else")?.slug, "flagon-io");
  assert.equal(chosenWorkspace(mine, null)?.slug, "flagon-io");
  assert.equal(chosenWorkspace([], "syntaqx"), null);
});

test("a project in one of your workspaces is about that workspace", () => {
  // Chose Flagon, looking at syntaqx/g1t: syntaqx, the project's own.
  assert.equal(workspaceFor(mine, "flagon-io", { owner: "syntaqx", repo: "g1t" })?.slug, "syntaqx");
  assert.equal(workspaceFor(mine, "syntaqx", { owner: "Flagon-IO", repo: "g1t" })?.slug, "flagon-io");
});

test("a project somewhere you do not belong leaves the chosen workspace", () => {
  // A public project somewhere else entirely: still Flagon.
  assert.equal(workspaceFor(mine, "flagon-io", { owner: "acme", repo: "web" })?.slug, "flagon-io");
  // Mission control: still Flagon.
  assert.equal(workspaceFor(mine, "flagon-io", {})?.slug, "flagon-io");
});

test("a workspace's own pages are about that workspace", () => {
  assert.equal(workspaceFor(mine, "flagon-io", { owner: "syntaqx" })?.slug, "syntaqx");
  // Not yours: the chosen one.
  assert.equal(workspaceFor(mine, "flagon-io", { owner: "acme" })?.slug, "flagon-io");
});

test("the cookie reads back what was remembered", () => {
  const set = rememberWorkspace("Flagon-IO", true);
  assert.match(set, /^g1t_ws=flagon-io; Path=\/; Max-Age=31536000; SameSite=Lax; Secure$/);
  assert.equal(readCookie("a=1; g1t_ws=flagon-io; b=2", "g1t_ws"), "flagon-io");
  assert.equal(readCookie(null, "g1t_ws"), null);
  assert.equal(readCookie("g1t_ws=%E0%A4%A", "g1t_ws"), null);
});

test("a deleted workspace you had chosen gives way to another, or to none", () => {
  // syntaqx deleted: the cookie still names it, and you are in Flagon only.
  assert.equal(chosenWorkspace([{ slug: "flagon-io" }], "syntaqx")?.slug, "flagon-io");
  assert.equal(workspaceFor([{ slug: "flagon-io" }], "syntaqx", {})?.slug, "flagon-io");
  // In no workspace at all: an account still works, with nothing chosen.
  assert.equal(workspaceFor([], "syntaqx", {}), null);
  assert.match(forgetWorkspace(true), /^g1t_ws=; Path=\/; Max-Age=0; SameSite=Lax; Secure$/);
});
