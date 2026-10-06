import assert from "node:assert/strict";
import { test } from "node:test";

import { STATUS_JSON_URL, dotClass, statusTitle } from "./status.ts";

test("the status page lives on its own host", () => {
  assert.equal(STATUS_JSON_URL, "https://status.g1t.sh/status.json");
});

test("the short line is the report's title, else words for its state", () => {
  assert.equal(statusTitle({ overall: { state: "up", title: "All systems normal", line: "" } }), "All systems normal");
  assert.equal(statusTitle({ overall: { state: "down", title: "", line: "" } }), "Major outage");
  assert.equal(statusTitle(null), null);
});

test("each state has its own dot", () => {
  assert.equal(dotClass("up"), "bg-accent");
  assert.equal(dotClass("degraded"), "bg-warn");
  assert.equal(dotClass("down"), "bg-danger");
  assert.equal(dotClass("unknown"), "bg-faint");
  assert.equal(dotClass(null), "bg-faint");
});
