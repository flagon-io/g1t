import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { RepoMirror } from "@g1t/contracts";

import { tabsFor } from "./project-nav.ts";
import { ROADMAP } from "./roadmap.ts";

const mirror = (state: RepoMirror["state"]): RepoMirror => ({ state, remote: "github.com/acme/web", url: "https://github.com/acme/web", since: "2026-10-08T10:00:00Z" });
const can = { security_alerts: true };

test("a mirror has tabs only for the pages it offers", () => {
  const labels = (tabs: ReturnType<typeof tabsFor>) => tabs?.map((tab) => tab.label) ?? null;
  // Code and Security read the same whoever leads.
  assert.deepEqual(labels(tabsFor("commits", true, can, mirror("standby"))), labels(tabsFor("commits", true, can, null)));
  assert.deepEqual(labels(tabsFor("security/vulnerabilities", true, can, mirror("standby"))), labels(tabsFor("security/vulnerabilities", true, can, null)));
  // Issues and the pull requests' tabs (with their sessions) come with a takeover.
  assert.equal(tabsFor("issues", true, can, mirror("standby")), null);
  assert.equal(tabsFor("sessions", true, can, mirror("ci")), null);
  assert.equal(tabsFor("queue", true, can, mirror("handing_back")), null);
  assert.ok(tabsFor("issues", true, can, mirror("takeover")));
  assert.ok(tabsFor("queue", true, can, mirror("takeover")));
});

test("code is not docs: a project never gets a Docs tab", () => {
  // Docs is its own workspace mode, filtered by project there.
  assert.equal(ROADMAP.some((item) => item.section !== "Workspace" && /docs/i.test(item.key)), false);
  const nav = readFileSync(new URL("./project-nav.ts", import.meta.url), "utf8");
  assert.doesNotMatch(nav, /label: "Docs"|soon\("Code"\)/);
});
