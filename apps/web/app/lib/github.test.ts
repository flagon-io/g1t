import assert from "node:assert/strict";
import { test } from "node:test";

import { INSTALL_COOKIE, STATE_COOKIE, cookie, installCookieValue, installWorkspace, newState, readCookie, sameString, stateMatches } from "./github.ts";

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
