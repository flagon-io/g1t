import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_DEFAULT_CHANNELS, mayCreateChannel, mayManageChannel, permissionsFor, rowFor, settingsChange, settingsOf } from "./settings.ts";

test("a workspace without settings lets every member make channels, and new people land in #general", () => {
  const settings = settingsOf(null, "chn_general");
  assert.deepEqual(settings, {
    public_channels: "members",
    private_channels: "members",
    manage_channels: "channel_owners",
    emoji_upload: "members",
    default_channels: ["chn_general"],
  });
  assert.deepEqual(settingsOf(null).default_channels, []);
});

test("default channels once chosen are kept as chosen, even none", () => {
  const row = { emoji_upload: "admins", public_channels: "owners", private_channels: "members", manage_channels: "owners", default_channels: "[]" };
  const settings = settingsOf(row, "chn_general");
  assert.deepEqual(settings.default_channels, []);
  assert.equal(settings.emoji_upload, "admins");
  assert.equal(settings.public_channels, "owners");
  assert.equal(settings.manage_channels, "owners");
  assert.deepEqual(settingsOf({ ...row, default_channels: '["a","b"]' }).default_channels, ["a", "b"]);
  // Anything unreadable is the defaults, never an error.
  assert.deepEqual(settingsOf({ ...row, default_channels: "{nope" }).default_channels, []);
  assert.equal(settingsOf({ ...row, public_channels: "everyone" }).public_channels, "members");
});

test("who may make a channel follows its visibility's setting", () => {
  const settings = settingsOf({ emoji_upload: null, public_channels: "members", private_channels: "owners", manage_channels: null, default_channels: null });
  assert.equal(mayCreateChannel(settings, "member", false), true);
  assert.equal(mayCreateChannel(settings, "member", true), false);
  assert.equal(mayCreateChannel(settings, "owner", true), true);
  assert.equal(mayCreateChannel(settings, null, false), false);
});

test("renaming and archiving: workspace owners always, a channel's owners unless kept to workspace owners", () => {
  const open = settingsOf(null);
  assert.equal(mayManageChannel(open, "owner", null), true);
  assert.equal(mayManageChannel(open, "member", "owner"), true);
  assert.equal(mayManageChannel(open, "member", "member"), false);
  assert.equal(mayManageChannel(open, null, "owner"), false);
  const strict = { ...open, manage_channels: "owners" as const };
  assert.equal(mayManageChannel(strict, "member", "owner"), false);
  assert.equal(mayManageChannel(strict, "owner", "member"), true);
});

test("what a role may do, for the page", () => {
  const settings = { ...settingsOf(null), public_channels: "owners" as const, emoji_upload: "admins" as const };
  assert.deepEqual(permissionsFor(settings, "member"), {
    create_public_channels: false,
    create_private_channels: true,
    add_emoji: false,
    manage_settings: false,
  });
  assert.deepEqual(permissionsFor(settings, "owner"), {
    create_public_channels: true,
    create_private_channels: true,
    add_emoji: true,
    manage_settings: true,
  });
});

test("a change is checked field by field; what is left out stays", () => {
  assert.deepEqual(settingsChange({ public_channels: "owners" }), { ok: true, change: { public_channels: "owners" } });
  assert.deepEqual(settingsChange({ default_channels: ["a", "a", "b"] }), { ok: true, change: { default_channels: ["a", "b"] } });
  assert.equal(settingsChange({ public_channels: "admins" }).ok, false);
  assert.equal(settingsChange({ manage_channels: "members" }).ok, false);
  assert.equal(settingsChange({ emoji_upload: "owners" }).ok, false);
  assert.equal(settingsChange({ default_channels: "general" }).ok, false);
  assert.equal(settingsChange({ default_channels: Array.from({ length: MAX_DEFAULT_CHANNELS + 1 }, (_, i) => `c${i}`) }).ok, false);
  assert.equal(settingsChange(null).ok, false);
});

test("settings are kept with their default channels as JSON", () => {
  assert.deepEqual(rowFor({ ...settingsOf(null), default_channels: ["x"] }), {
    emoji_upload: "members",
    public_channels: "members",
    private_channels: "members",
    manage_channels: "channel_owners",
    default_channels: '["x"]',
  });
});
