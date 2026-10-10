import assert from "node:assert/strict";
import { test } from "node:test";

import { changeRows, integrationHint, lineDiff, readDefinition } from "./agent-builder.ts";

test("a draft comes back from the page checked for shape", () => {
  const read = readDefinition(
    JSON.stringify({
      handle: "juniper",
      display_name: " Juniper ",
      title: "Release Manager",
      instructions: "Cut releases.",
      responsibilities: ["One", 2, "Two"],
      personality_preset: "loud",
      routing: { floor: "huge", ceiling: "small", providers: ["x"], pinned: "a/b" },
      budget: { monthly_micros: 20_000_000, task_micros: -1 },
      skills_off: ["data"],
      team: "ops",
      scope: "personal",
    }),
  );
  assert.ok(read);
  assert.equal(read.display_name, "Juniper");
  assert.deepEqual(read.responsibilities, ["One", "Two"]);
  assert.equal(read.personality_preset, "crisp");
  assert.deepEqual(read.routing, { floor: null, ceiling: "small", providers: [], pinned: null }, "nothing but limits");
  assert.deepEqual(read.budget, { monthly_micros: 20_000_000, daily_micros: null, task_micros: null });
  assert.equal(read.team, null, "a draft is on no team");
  assert.equal(read.scope, "personal");
  assert.equal(readDefinition("not json"), null);
  assert.equal(readDefinition("[1]"), null);
});

test("an integration it needs: owners connect it, anyone else asks, and soon is soon", () => {
  const owner = integrationHint("acme", { id: "linear", why: "Reads issues." }, true);
  assert.equal(owner?.action, "connect");
  assert.equal(owner?.href, "/acme/-/integrations/trackers?add=linear#add");
  const member = integrationHint("acme", { id: "linear", why: "Reads issues." }, false);
  assert.deepEqual(member && { action: member.action, href: member.href }, { action: "ask", href: "/acme/-/marketplace/integrations/linear" });
  assert.equal(integrationHint("acme", { id: "box", why: "" }, true)?.action, "soon");
  assert.equal(integrationHint("acme", { id: "nope", why: "" }, true), null);
});

test("a job's change reads as lines kept, removed and added", () => {
  assert.deepEqual(lineDiff("a\nb\nc", "a\nB\nc\nd"), [
    { kind: "same", text: "a" },
    { kind: "removed", text: "b" },
    { kind: "added", text: "B" },
    { kind: "same", text: "c" },
    { kind: "added", text: "d" },
  ]);
  assert.deepEqual(lineDiff("same", "same"), [{ kind: "same", text: "same" }]);
});

test("a drafted change lists each field it touches, before and after", () => {
  const agent = {
    handle: "juniper",
    display_name: "Juniper",
    title: "Release Manager",
    department: "",
    instructions: "Cut releases.",
    responsibilities: ["One", "Two"],
    personality_preset: "crisp" as const,
    personality: "",
    skills_off: [],
    routing: { floor: null, ceiling: null, providers: [], pinned: null },
    budget: { monthly_micros: 20_000_000, daily_micros: null, task_micros: 2_000_000 },
  };
  const rows = changeRows(agent as never, {
    display_name: "Wren",
    handle: "wren",
    instructions: "Cut releases.\nAnswer in Spanish.",
    skills_off: ["data"],
    routing: { ceiling: "small" },
    budget: { monthly_micros: 50_000_000 },
  });
  assert.deepEqual(
    rows.map((r) => [r.label, r.before, r.after]),
    [
      ["Name", "Juniper", "Wren"],
      ["Handle", "@juniper", "@wren"],
      ["Job", "Cut releases.", "Cut releases.\nAnswer in Spanish."],
      ["Skills", "All on", "Turned off: data"],
      ["Model ceiling", "None", "Fast"],
      ["Monthly budget", "$20", "$50"],
    ],
  );
  assert.equal(rows[2]!.lines?.filter((l) => l.kind === "added").length, 1);
});
