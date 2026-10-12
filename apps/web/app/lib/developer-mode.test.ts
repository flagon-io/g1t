import assert from "node:assert/strict";
import { test } from "node:test";

import { debugReport, describeError, developerCookie, readDeveloperMode, wantsServerErrors } from "./developer-mode.ts";

const request = (cookie: string | null, authorization?: string) =>
  new Request("https://g1t.sh/acme", { headers: { ...(cookie ? { cookie } : {}), ...(authorization ? { authorization } : {}) } });

test("developer mode is on only for the cookie's own value", () => {
  assert.equal(readDeveloperMode("1"), true);
  for (const junk of ["", "true", "0", null, undefined]) assert.equal(readDeveloperMode(junk), false);
});

test("the cookie keeps the choice for a year, and turning it off forgets it", () => {
  assert.equal(developerCookie(true, true), "g1t_dev=1; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
  assert.equal(developerCookie(false, false), "g1t_dev=; Path=/; Max-Age=0; SameSite=Lax");
});

test("the server's own errors go only to someone signed in who turned it on", () => {
  assert.equal(wantsServerErrors(request("g1t_session=abc; g1t_dev=1")), true);
  assert.equal(wantsServerErrors(request("g1t_dev=1; g1t_theme=dark", "Bearer g1t_x")), true);
  assert.equal(wantsServerErrors(request("g1t_dev=1")), false);
  assert.equal(wantsServerErrors(request("g1t_session=abc")), false);
  assert.equal(wantsServerErrors(request("g1t_session=abc; g1t_dev=10")), false);
  assert.equal(wantsServerErrors(request("g1t_session=abc; not_g1t_dev=1")), false);
});

test("whatever was thrown is described", () => {
  const thrown = describeError(new TypeError("x is undefined"));
  assert.equal(thrown.kind, "TypeError");
  assert.equal(thrown.message, "x is undefined");
  const response = describeError({ status: 500, statusText: "Internal Server Error", data: "the sidebar could not be read" });
  assert.deepEqual([response.kind, response.status, response.message, response.data], ["Response", 500, "500 Internal Server Error", "the sidebar could not be read"]);
  assert.deepEqual([describeError("plain").kind, describeError("plain").message], ["string", "plain"]);
});

test("one report says what failed, where, when and on which build", () => {
  const error = new Error("Cannot read properties of undefined (reading 'slug')");
  error.stack = "Error: Cannot read properties of undefined\n    at Integrations (integrations.tsx:10:5)";
  const report = debugReport({
    url: "https://g1t.sh/flagon-io/-/integrations",
    at: new Date("2026-10-12T23:00:00Z"),
    error,
    routes: ["root", "routes/workspace/integrations"],
    build: "app-Ab12Cd.css",
    userAgent: "Chrome",
    desktop: "0.3.6",
    navigation: "client",
  });
  for (const line of [
    "URL: https://g1t.sh/flagon-io/-/integrations",
    "Time: 2026-10-12T23:00:00.000Z",
    "Loaded: a navigation in the browser",
    "Routes: root > routes/workspace/integrations",
    "Desktop app: 0.3.6",
    "Error: Cannot read properties of undefined (reading 'slug')",
    "    at Integrations (integrations.tsx:10:5)",
  ]) {
    assert.ok(report.includes(line), `${line} in:\n${report}`);
  }
  assert.ok(debugReport({ url: "/", at: null, error, routes: [], build: "b", userAgent: "", navigation: "document" }).includes("Time: (not yet in the browser)"));
});
