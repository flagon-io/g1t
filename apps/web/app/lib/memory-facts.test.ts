import assert from "node:assert/strict";
import { test } from "node:test";

import { distinctFacts, sameFact } from "./memory-facts.ts";

test("a fact remembered twice is shown once, the first kept", () => {
  const facts = [
    { id: "a", text: "Run tests with npm test." },
    { id: "b", text: "We use pnpm everywhere" },
    { id: "c", text: "run tests  with npm test" },
    { id: "d", text: "We use pnpm everywhere." },
  ];
  assert.deepEqual(distinctFacts(facts).map((fact) => fact.id), ["a", "b"]);
  assert.deepEqual(distinctFacts([]), []);
});

test("near-duplicates collapse: a list that grew, a sentence cut short", () => {
  const facts = [
    { id: "a", text: "g1t is a Cargo workspace (apps/api, crates/*, services/actions, services/billing); `cargo test` runs its tests." },
    { id: "b", text: "g1t is a Cargo workspace (apps/api, crates/*, services/actions, services/billing, services/work); `cargo test` runs its tests." },
    { id: "c", text: "Roles. Viewer, commenter, planner and approver map onto" },
    { id: "d", text: "Roles. Viewer, commenter, planner and approver map onto the five repository roles." },
    { id: "e", text: "Use npm to install." },
    { id: "f", text: "Use pnpm to install." },
  ];
  assert.deepEqual(distinctFacts(facts).map((fact) => fact.id), ["a", "c", "e", "f"]);
  assert.ok(!sameFact("Run cargo test in the crate you changed.", "Run npm test in the app you changed."));
  assert.ok(!sameFact("use pnpm", "use pnpm in the web app and npm in the docs, which predates it"));
});
