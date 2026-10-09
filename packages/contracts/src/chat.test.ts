import assert from "node:assert/strict";
import { test } from "node:test";

import { memberHandle, memberName } from "./chat.ts";

test("a member shows by their display name first", () => {
  assert.equal(memberName({ name: "ana", display_username: "Ana", display_name: "Ana Lima" }), "Ana Lima");
  assert.equal(memberName({ name: "reviewer", display_name: "Reviewer" }), "Reviewer");
});

test("without a display name, a member shows by their username in its chosen case", () => {
  assert.equal(memberName({ name: "ana", display_username: "AnaL", display_name: "" }), "ana");
  assert.equal(memberName({ name: "ana", display_username: "Ana", display_name: "  " }), "Ana");
  assert.equal(memberName({ name: "ana", display_name: null }), "ana");
});

test("a handle keeps its chosen case only when it is the same name", () => {
  assert.equal(memberHandle({ name: "chase", display_username: "Chase" }), "Chase");
  assert.equal(memberHandle({ name: "chase", display_username: "Other" }), "chase");
  assert.equal(memberHandle({ name: "chase" }), "chase");
});
