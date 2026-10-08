import assert from "node:assert/strict";
import { test } from "node:test";

import { inlineParts, inlinePlain } from "./inline-markdown.ts";

test("bold, italic, code and links read as marks", () => {
  assert.deepEqual(inlineParts("**Conflict resolved.** The conflict was in `module.exports`."), [
    { kind: "strong", text: "Conflict resolved." },
    { kind: "text", text: " The conflict was in " },
    { kind: "code", text: "module.exports" },
    { kind: "text", text: "." },
  ]);
  assert.deepEqual(inlineParts("in sudo (**Platform → Incidents**, `https://sudo.g1t.sh/incidents`)"), [
    { kind: "text", text: "in sudo (" },
    { kind: "strong", text: "Platform → Incidents" },
    { kind: "text", text: ", " },
    { kind: "code", text: "https://sudo.g1t.sh/incidents" },
    { kind: "text", text: ")" },
  ]);
  assert.deepEqual(inlineParts("an *important* step, see [the docs](https://docs.g1t.sh/)"), [
    { kind: "text", text: "an " },
    { kind: "em", text: "important" },
    { kind: "text", text: " step, see the docs" },
  ]);
});

test("what is not a mark stays as written", () => {
  assert.deepEqual(inlineParts("snake_case_name and 2 * 3 * 4"), [{ kind: "text", text: "snake_case_name and 2 * 3 * 4" }]);
  assert.deepEqual(inlineParts("**Conflicts resolved:**"), [{ kind: "strong", text: "Conflicts resolved:" }]);
  assert.deepEqual(inlineParts(""), []);
  // Inside code, nothing else is read.
  assert.deepEqual(inlineParts("`a **b** c`"), [{ kind: "code", text: "a **b** c" }]);
});

test("the plain words, for a tooltip", () => {
  assert.equal(inlinePlain("**Done.** Wrote `math.js`."), "Done. Wrote math.js.");
});
