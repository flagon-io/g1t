import assert from "node:assert/strict";
import { test } from "node:test";

import { distinctFacts } from "./memory-facts.ts";

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
