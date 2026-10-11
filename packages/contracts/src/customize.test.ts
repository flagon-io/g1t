import assert from "node:assert/strict";
import { test } from "node:test";

import { CUSTOMIZE, CUSTOMIZE_SECTIONS, customizePath, sectionOfListing } from "./customize.ts";

test("every listing has a place in Customize", () => {
  assert.equal(sectionOfListing("integration"), "connectors");
  assert.equal(sectionOfListing("connector"), "connectors");
  assert.equal(sectionOfListing("skill"), "skills");
  assert.equal(sectionOfListing("plugin"), "plugins");
  assert.equal(sectionOfListing("extension"), "plugins");
  for (const section of CUSTOMIZE_SECTIONS) assert.equal(CUSTOMIZE[section].id, section);
});

test("a section's site path names its workspace", () => {
  assert.equal(customizePath("connectors", "acme"), "/acme/-/customize/connectors");
  assert.equal(customizePath("skills", "a b"), "/a%20b/-/customize/skills");
  assert.equal(customizePath("", "acme"), "/acme/-/customize");
  assert.equal(customizePath("plugins", "acme", "pdf@anthropic-agent-skills"), "/acme/-/customize/plugins/pdf@anthropic-agent-skills");
});
