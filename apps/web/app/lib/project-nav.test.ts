import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ROADMAP } from "./roadmap.ts";

test("code is not docs: a project never gets a Docs tab", () => {
  // Docs is its own workspace mode, filtered by project there.
  assert.equal(ROADMAP.some((item) => item.section !== "Workspace" && /docs/i.test(item.key)), false);
  const nav = readFileSync(new URL("./project-nav.ts", import.meta.url), "utf8");
  assert.doesNotMatch(nav, /label: "Docs"|soon\("Code"\)/);
});
