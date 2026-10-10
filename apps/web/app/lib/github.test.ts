import assert from "node:assert/strict";
import { test } from "node:test";

import { connectorsFor } from "@g1t/contracts/connectors";

import {
  INSTALL_COOKIE,
  STATE_COOKIE,
  cookie,
  githubConnected,
  installCookieValue,
  installWorkspace,
  installationSummary,
  newState,
  notYetAdded,
  readCookie,
  sameString,
  setupChoices,
  stateMatches,
} from "./github.ts";
import { integrationListings } from "./marketplace.ts";

test("the state must come back exactly as it was given", () => {
  const state = newState();
  assert.match(state, /^[0-9a-f]{64}$/);
  assert.notEqual(state, newState());
  assert.ok(stateMatches(state, state));
  assert.ok(!stateMatches(state, state.slice(0, -1) + (state.endsWith("0") ? "1" : "0")));
  assert.ok(!stateMatches(null, state));
  assert.ok(!stateMatches(state, null));
  assert.ok(!stateMatches("", ""));
  assert.ok(!sameString("abc", "abcd"));
});

test("cookies are read by name, and odd values are ignored", () => {
  const header = `g1t_session=${"a".repeat(64)}; ${STATE_COOKIE}=abc123; other=x`;
  assert.equal(readCookie(header, STATE_COOKIE), "abc123");
  assert.equal(readCookie(header, "missing"), null);
  assert.equal(readCookie(`${STATE_COOKIE}=<script>`, STATE_COOKIE), null);
  assert.equal(readCookie(null, STATE_COOKIE), null);
  const set = cookie(STATE_COOKIE, "abc", 600);
  assert.match(set, /HttpOnly/);
  assert.match(set, /Secure/);
  assert.match(set, /SameSite=Lax/);
  assert.match(set, /Max-Age=600/);
});

test("an installation returns to the workspace it was started for", () => {
  const state = newState();
  const value = installCookieValue(state, "acme");
  assert.equal(readCookie(`${INSTALL_COOKIE}=${value}`, INSTALL_COOKIE), value);
  assert.equal(installWorkspace(value, state), "acme");
  assert.equal(installWorkspace(value, newState()), null);
  assert.equal(installWorkspace(value, null), null);
  assert.equal(installWorkspace(null, state), null);
  assert.equal(installWorkspace(`${state}.`, state), null);
});

const seen = (id: number, account: string, recordedIn: string[], accountType = "Organization") => ({
  id,
  account,
  accountType,
  repositorySelection: "all",
  suspended: false,
  settingsUrl: `https://github.com/organizations/${account}/settings/installations/${id}`,
  recordedIn,
});

test("an installation made on GitHub directly is offered to the workspaces that lack it", () => {
  const listed = [seen(1, "flagon-io", []), seen(2, "syntaqx", ["syntaqx"], "User"), seen(3, "acme", ["flagon-io"])];
  assert.deepEqual(
    notYetAdded(listed, "flagon-io").map((item) => item.account),
    ["flagon-io", "syntaqx"],
  );
  assert.deepEqual(
    notYetAdded(listed, "syntaqx").map((item) => item.id),
    [1, 3],
  );
  assert.equal(installationSummary(listed[0]!), "Organization · all repositories");
  assert.equal(installationSummary({ accountType: "User", repositorySelection: "selected" }), "Personal · selected repositories");
});

test("the setup page offers only workspaces the person owns, saying which have it", () => {
  const workspaces = [
    { slug: "flagon-io", name: "Flagon", role: "owner" },
    { slug: "acme", role: "member" },
    { slug: "syntaqx", name: null, role: "owner" },
  ];
  assert.deepEqual(setupChoices(workspaces, seen(1, "flagon-io", ["syntaqx"])), [
    { slug: "flagon-io", name: "Flagon", added: false },
    { slug: "syntaqx", name: "syntaqx", added: true },
  ]);
  assert.deepEqual(
    setupChoices(workspaces, null).map((choice) => choice.added),
    [false, false],
  );
});

test("once an installation is recorded, the Marketplace and Integrations say GitHub is connected", () => {
  assert.equal(githubConnected([]), null);
  const state = githubConnected([{ account: "flagon-io", suspended: false }]);
  assert.deepEqual(state, { detail: "On flagon-io", problem: null, manage: null });
  const listings = integrationListings(connectorsFor("workspace"), { github: state! }, [], "ana", "flagon-io");
  const github = listings.find((listing) => listing.view.id === "github");
  assert.equal(github?.connected?.detail, "On flagon-io");
  assert.equal(listings[0]!.view.id, "github");
  assert.equal(
    githubConnected([
      { account: "a", suspended: false },
      { account: "b", suspended: true },
    ])?.problem,
    "The installation on b is suspended on GitHub.",
  );
});
