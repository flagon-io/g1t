import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ChecklistFacts,
  agentWasAssigned,
  dismiss,
  dismissKey,
  hasInstructions,
  isDismissed,
  productionChecklist,
  progress,
  releaseChecklist,
} from "./checklist.ts";

const fresh: ChecklistFacts = {
  base: "/acme/web",
  hasCode: false,
  deploysEnabled: false,
  productionDeployed: false,
  domains: 0,
  previewOpened: false,
  instructions: false,
  agentAssigned: false,
};

test("a new project has everything to do, in order", () => {
  const items = productionChecklist(fresh);
  assert.deepEqual(
    items.map((item) => item.key),
    ["code", "deploy", "domain", "preview", "instructions", "agent"],
  );
  assert.deepEqual(progress(items), { done: 0, total: 6, complete: false });
});

test("each step is done from its own fact", () => {
  const items = productionChecklist({ ...fresh, hasCode: true, productionDeployed: true, domains: 2 });
  assert.deepEqual(progress(items), { done: 3, total: 6, complete: false });
  const all = productionChecklist({
    ...fresh,
    hasCode: true,
    productionDeployed: true,
    domains: 1,
    previewOpened: true,
    instructions: true,
    agentAssigned: true,
  });
  assert.equal(progress(all).complete, true);
});

test("unknown facts count as not done", () => {
  const items = productionChecklist({ ...fresh, domains: null, instructions: null });
  assert.equal(items.find((item) => item.key === "domain")?.done, false);
  assert.equal(items.find((item) => item.key === "instructions")?.done, false);
});

test("each step links to where it is done", () => {
  const off = productionChecklist(fresh);
  assert.equal(off.find((item) => item.key === "deploy")?.to, "/acme/web/settings/deployments");
  const on = productionChecklist({ ...fresh, deploysEnabled: true });
  assert.equal(on.find((item) => item.key === "deploy")?.to, "/acme/web/deployments");
  assert.equal(on.find((item) => item.key === "domain")?.to, "/acme/web/settings/domains");
  assert.equal(on.find((item) => item.key === "agent")?.to, "/acme/web/issues/new");
});

test("instructions are AGENTS.md or CLAUDE.md at the root", () => {
  assert.equal(hasInstructions(["README.md", "AGENTS.md"]), true);
  assert.equal(hasInstructions(["claude.md"]), true);
  assert.equal(hasInstructions(["README.md", "AGENTS.mdx", "docs"]), false);
});

test("g1t counts as assigned from a run, a pull request or an issue", () => {
  const none = { runAgents: ["claude-code"], pullAgents: ["claude-code"], issues: [{ assignees: ["ana"], agent: null }] };
  assert.equal(agentWasAssigned(none), false);
  assert.equal(agentWasAssigned({ ...none, runAgents: ["g1t"] }), true);
  assert.equal(agentWasAssigned({ ...none, pullAgents: ["g1t"] }), true);
  assert.equal(agentWasAssigned({ ...none, issues: [{ assignees: ["G1T"], agent: null }] }), true);
  assert.equal(agentWasAssigned({ ...none, issues: [{ assignees: [], agent: "g1t" }] }), true);
});

test("dismissing is remembered per project, and storage that throws is ignored", () => {
  const map = new Map<string, string>();
  const store = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
  assert.equal(isDismissed(() => store, "/acme/web"), false);
  assert.equal(dismiss(() => store, "/Acme/Web"), true);
  assert.equal(isDismissed(() => store, "/acme/web"), true);
  assert.equal(isDismissed(() => store, "/acme/api"), false);
  assert.equal(dismissKey("/Acme/Web"), "g1t:checklist-dismissed:/acme/web");
  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(isDismissed(() => blocked, "/acme/web"), false);
  assert.equal(dismiss(() => blocked, "/acme/web"), false);
});

test("a library's checklist ships a release instead of deploying", () => {
  const facts = {
    base: "/flagon-io/php-log",
    hasCode: true,
    instructions: false,
    agentAssigned: false,
    hasWorkflow: false,
    released: true,
    releaseTo: "/flagon-io/-/packages/composer/psr/log",
  };
  const items = releaseChecklist(facts);
  assert.deepEqual(
    items.map((item) => item.key),
    ["code", "checks", "release", "instructions", "agent"],
  );
  assert.deepEqual(progress(items), { done: 2, total: 5, complete: false });
  assert.equal(items.find((item) => item.key === "checks")?.to, "/flagon-io/php-log/actions");
  assert.equal(items.find((item) => item.key === "release")?.to, "/flagon-io/-/packages/composer/psr/log");
  assert.ok(items.every((item) => !/deploy|production|domain|preview/i.test(item.title)));
  // An unknown workflow list counts as not done.
  assert.equal(releaseChecklist({ ...facts, hasWorkflow: null }).find((item) => item.key === "checks")?.done, false);
});
