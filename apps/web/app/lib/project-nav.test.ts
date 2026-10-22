import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { tabsFor } from "./project-nav.ts";
import { ROADMAP } from "./roadmap.ts";

test("code is not docs: a repository never gets a Docs tab", () => {
  // Docs is its own workspace mode, filtered by project there.
  assert.equal(
    ROADMAP.some((item) => item.section !== "Workspace" && /docs/i.test(item.key)),
    false,
  );
  const nav = readFileSync(new URL("./project-nav.ts", import.meta.url), "utf8");
  assert.doesNotMatch(nav, /label: "Docs"|soon\("Code"\)/);
});

test("build configuration is discoverable under deployments only with integration access", () => {
  const writer = tabsFor("settings/deployments", true, { manage_integrations: true });
  assert.ok(writer?.some((tab) => tab.path === "deployments"));
  assert.ok(writer?.some((tab) => tab.path === "settings/deployments"));
  assert.equal(tabsFor("deployments", false), null);
  assert.equal(tabsFor("deployments", true, { manage_integrations: false }), null);
});

test("Storage is planned while implemented environments are no longer marked Soon", () => {
  assert.equal(ROADMAP.find((item) => item.key === "storage")?.section, "Repository");
  assert.equal(
    ROADMAP.some((item) => item.key === "environments"),
    false,
  );
});
