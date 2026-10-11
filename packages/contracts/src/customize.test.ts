import assert from "node:assert/strict";
import { test } from "node:test";

import { CUSTOMIZE, CUSTOMIZE_SECTIONS, customizePath, sectionOfListing } from "./customize.ts";

test("every Marketplace listing has a place in Customize", () => {
  assert.equal(sectionOfListing("integration"), "connectors");
  assert.equal(sectionOfListing("extension"), "plugins");
  for (const section of CUSTOMIZE_SECTIONS) assert.equal(CUSTOMIZE[section].id, section);
});

test("a section's site path names its workspace", () => {
  assert.equal(customizePath("connectors", "acme"), "/acme/-/marketplace/integrations");
  assert.equal(customizePath("skills", "a b"), "/a%20b/-/agents/skills");
});
