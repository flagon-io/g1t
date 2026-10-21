import assert from "node:assert/strict";
import { test } from "node:test";

import { PALETTE_KEY, isNewChatKey, modKeyLabel, newChatKeyLabel, shortcutsKeyLabel } from "./shortcut.ts";

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

test("New chat is Shift and Command O on a Mac, Ctrl Shift O elsewhere", () => {
  assert.equal(newChatKeyLabel("macOS"), "⇧⌘O");
  assert.equal(newChatKeyLabel("Win32"), "Ctrl Shift O");
  assert.equal(newChatKeyLabel(null), "Ctrl Shift O");
  const press = (key: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "shiftKey" | "altKey", boolean>>) =>
    isNewChatKey({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
  assert.equal(press("O", { ctrlKey: true, shiftKey: true }), true);
  assert.equal(press("o", { metaKey: true, shiftKey: true }), true);
  assert.equal(press("o", { ctrlKey: true }), false, "Ctrl O is the browser's Open");
  assert.equal(press("O", { shiftKey: true }), false, "a capital O, typed");
  assert.equal(press("o", { ctrlKey: true, shiftKey: true, altKey: true }), false);
  assert.equal(press("k", { ctrlKey: true, shiftKey: true }), false);
});
