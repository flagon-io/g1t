import assert from "node:assert/strict";
import { test } from "node:test";

import { changesShell } from "./shell-changes.ts";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

test("what changes the account, its workspaces or the inbox reloads the frame", () => {
  assert.equal(changesShell("/settings/profile"), true);
  assert.equal(changesShell("/settings/notifications"), true, "chat sounds are the root's");
  assert.equal(changesShell("/notifications"), true, "the inbox's views are counted in the sidebar");
  assert.equal(changesShell("/workspaces/new"), true);
  assert.equal(changesShell("/invite/abc123"), true);
  assert.equal(changesShell("/new"), true, "a new project joins the sidebar");
  assert.equal(changesShell("/logout"), true);
});

test("a workspace's own settings, members, projects, pins and plan reload the frame", () => {
  for (const page of ["settings", "members/invitations", "people/ada", "billing", "usage", "ai", "pins", "apps", "repositories", "teams/new"]) {
    assert.equal(changesShell(`/acme/-/${page}`), true, page);
  }
  assert.equal(changesShell("/acme/-/settings?index"), true, "the query is not the page");
});

test("work, chat, artifacts and the rest of a workspace keep the frame as it is", () => {
  for (const page of ["work/12", "work/new", "work/triage", "artifacts/new/doc", "secrets", "webhooks", "home/seen", "onboarding", "guardrails"]) {
    assert.equal(changesShell(`/acme/-/${page}`), false, page);
  }
});

test("a project's settings, fork and kind reload the frame; its code, reviews and comments do not", () => {
  assert.equal(changesShell("/acme/api?index"), true, "its kind, set from its overview");
  assert.equal(changesShell("/acme/api/settings/repository"), true);
  assert.equal(changesShell("/acme/api/settings/access"), true);
  assert.equal(changesShell("/acme/api/fork"), true);
  assert.equal(changesShell("/acme/api/pulls/new"), true, "one more open pull request");
  assert.equal(changesShell("/acme/api/star"), false);
  assert.equal(changesShell("/acme/api/commit/abc"), false);
  assert.equal(changesShell("/acme/api/releases/new"), false);
  assert.equal(changesShell("/acme/api/security/settings"), false);
});

test("on a pull request, only what opens or closes it changes the open count", () => {
  assert.equal(changesShell("/acme/api/pull/7", form({ action: "merge" })), true);
  assert.equal(changesShell("/acme/api/pull/7", form({ action: "close" })), true);
  assert.equal(changesShell("/acme/api/pull/7/files", form({ action: "reopen" })), true);
  assert.equal(changesShell("/acme/api/pull/7", form({ action: "comment" })), false);
  assert.equal(changesShell("/acme/api/pull/7", form({ action: "react" })), false);
  assert.equal(changesShell("/acme/api/pull/7"), false);
});

test("a submission whose address is not known reloads, as before", () => {
  assert.equal(changesShell(undefined), true);
});
