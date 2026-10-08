import assert from "node:assert/strict";
import { test } from "node:test";

import { paletteKeyLabel } from "./shortcut.ts";

test("a Mac shows the Command key, everything else Ctrl", () => {
  assert.equal(paletteKeyLabel("macOS"), "⌘K");
  assert.equal(paletteKeyLabel("MacIntel"), "⌘K");
  assert.equal(paletteKeyLabel("iPad"), "⌘K");
  assert.equal(paletteKeyLabel("Windows"), "Ctrl K");
  assert.equal(paletteKeyLabel("Win32"), "Ctrl K");
  assert.equal(paletteKeyLabel("Linux x86_64"), "Ctrl K");
  assert.equal(paletteKeyLabel(""), "Ctrl K");
  assert.equal(paletteKeyLabel(null), "Ctrl K");
});
