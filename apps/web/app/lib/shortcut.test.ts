import assert from "node:assert/strict";
import { test } from "node:test";

import { PALETTE_KEY, modKeyLabel, shortcutsKeyLabel } from "./shortcut.ts";

test("a Mac shows the Command key, everything else Ctrl", () => {
  assert.equal(shortcutsKeyLabel("macOS"), "⌘K");
  assert.equal(shortcutsKeyLabel("MacIntel"), "⌘K");
  assert.equal(shortcutsKeyLabel("iPad"), "⌘K");
  assert.equal(shortcutsKeyLabel("Windows"), "Ctrl K");
  assert.equal(shortcutsKeyLabel("Win32"), "Ctrl K");
  assert.equal(shortcutsKeyLabel("Linux x86_64"), "Ctrl K");
  assert.equal(shortcutsKeyLabel(""), "Ctrl K");
  assert.equal(shortcutsKeyLabel(null), "Ctrl K");
  assert.equal(modKeyLabel("macOS", "B"), "⌘B");
  assert.equal(modKeyLabel("Windows", "B"), "Ctrl B");
});

test("search is / on every computer", () => {
  assert.equal(PALETTE_KEY, "/");
});
