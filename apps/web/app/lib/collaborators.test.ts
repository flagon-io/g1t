import assert from "node:assert/strict";
import { test } from "node:test";

import { givenHere } from "./collaborators.ts";

test("only people given a role here are listed, as GitHub lists collaborators", () => {
  const people = [
    { username: "owner", source: "owner", direct: "admin" },
    { username: "member", source: "base", direct: null },
    { username: "teamed", source: "team", direct: null },
    { username: "raised", source: "direct", direct: "maintain" },
    { username: "raised-and-teamed", source: "team", direct: "write" },
    { username: "guest", source: "direct", direct: "read" },
  ] as const;
  assert.deepEqual(
    givenHere(people).map((person) => person.username),
    ["raised", "raised-and-teamed", "guest"],
  );
});
