import assert from "node:assert/strict";
import { test } from "node:test";

import { clientErrorReport } from "./client-errors.ts";

test("an error page's report says what failed, on which page and build, and nothing more", () => {
  const error = new TypeError("Cannot read properties of undefined (reading 'map')");
  const report = clientErrorReport(error, "/flagon-io", "build-a", true);
  assert.equal(report.name, "TypeError");
  assert.equal(report.message, "Cannot read properties of undefined (reading 'map')");
  assert.equal(report.path, "/flagon-io");
  assert.equal(report.build, "build-a");
  assert.equal(report.outdated, true);
  assert.equal(report.status, null);
  assert.ok(report.stack.split("\n").length <= 12);
});

test("a response the router threw is reported by its status", () => {
  const report = clientErrorReport({ status: 500, statusText: "Internal Server Error", data: "secret detail" }, "/flagon-io/g1t", "b", false);
  assert.equal(report.name, "ErrorResponse");
  assert.equal(report.status, 500);
  assert.equal(report.message, "500 Internal Server Error");
});

test("a long message is cut", () => {
  const report = clientErrorReport(new Error("x".repeat(10_000)), "/", "b", false);
  assert.equal(report.message.length, 2_000);
});
