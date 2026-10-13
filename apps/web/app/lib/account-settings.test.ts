import assert from "node:assert/strict";
import { test } from "node:test";

import { ACCOUNT_SETTINGS, accountSettingsPage, settingsPathForHash } from "./account-settings.ts";

test("every anchor of the old settings page lands on its own page", () => {
  const cases: [string, string][] = [
    ["#picture", "/settings/profile"],
    ["#profile", "/settings/profile"],
    ["#emails", "/settings/emails"],
    ["#github", "/settings/github"],
    ["#invites", "/settings/invites"],
    ["#ssh-keys", "/settings/keys"],
    ["#tokens", "/settings/tokens"],
    ["#applications", "/settings/applications"],
    ["#security-log", "/settings/security-log"],
  ];
  for (const [hash, path] of cases) assert.equal(settingsPathForHash(hash), path, hash);
  assert.equal(settingsPathForHash(""), null);
  assert.equal(settingsPathForHash("#nothing"), null);
});

test("a settings path names its page", () => {
  for (const page of Object.keys(ACCOUNT_SETTINGS)) {
    assert.equal(accountSettingsPage(`/settings/${page}`), page);
  }
  assert.equal(accountSettingsPage("/settings"), null);
  assert.equal(accountSettingsPage("/settings/nope"), null);
  assert.equal(accountSettingsPage("/settings/tokens/tok_1"), "tokens", "a token's page is under Access tokens");
  assert.equal(accountSettingsPage("/acme/web/settings/domains"), null);
});
