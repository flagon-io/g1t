import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUILTINS,
  MAX_APP_PINS,
  appData,
  appPinFromForm,
  dockCookie,
  installedAppOf,
  installedApps,
  integrationAppKey,
  isPinnable,
  pinsFrom,
  pinsIn,
  pinsToShow,
  readDock,
  sidebarClosed,
  sidebarCookie,
  withPin,
  writeDock,
} from "./apps.ts";

test("only apps installed from the Marketplace are pinned; built-in apps and their pages are not", () => {
  for (const app of BUILTINS) assert.equal(isPinnable(app.key), false, app.key);
  for (const page of ["projects", "packages", "security", "context", "memory", "teams", "usage", "gateway", "integrations", "audit"]) {
    assert.equal(isPinnable(page), false, page);
  }
  assert.equal(isPinnable("int-sentry"), true);
  assert.equal(isPinnable("int-slack"), false, "Slack can't be connected yet");
  assert.equal(isPinnable("int-mcp"), false, "MCP clients are each person's, not the workspace's");
  assert.equal(isPinnable("ext-support"), false, "no extensions yet");
  assert.equal(isPinnable("int-Sentry"), false);
});

test("an integration's app opens its page", () => {
  assert.equal(installedAppOf("int-sentry")?.path("acme"), "/acme/-/integrations/alerts");
  assert.equal(installedAppOf("int-linear")?.path("acme"), "/acme/-/integrations/trackers");
  assert.equal(installedAppOf("int-anthropic")?.path("acme"), "/acme/-/integrations/models");
  assert.equal(installedAppOf("int-webhooks")?.path("acme"), "/acme/-/webhooks");
  assert.equal(installedAppOf(integrationAppKey("github"))?.listing, "integration:github");
  // Every key fits what identity keeps (MAX_DOCK_APP_KEY, 32).
  assert.ok(integrationAppKey("anthropic-endpoint").length <= 32);
});

test("installed apps are what the workspace connected, opening where each is managed", () => {
  const apps = installedApps({ sentry: { manage: "/acme/-/integrations/alerts" }, github: { manage: null }, nonsense: { manage: null } });
  assert.deepEqual(apps.map((app) => app.key), ["int-github", "int-sentry"]);
  assert.equal(apps[0]!.path("acme"), "/new/github?workspace=acme");
  assert.deepEqual(appData(apps[1]!, "acme").href, "/acme/-/integrations/alerts");
  assert.deepEqual(installedApps({}), []);
});

test("pins are kept per workspace, in the order they were pinned", () => {
  const value = writeDock(writeDock(null, "acme", ["int-sentry", "int-linear"]), "Beta", ["int-jira"]);
  assert.equal(value, "beta:int-jira,acme:int-sentry.int-linear");
  assert.deepEqual(pinsIn(value, "acme"), ["int-sentry", "int-linear"]);
  assert.deepEqual(pinsIn(value, "BETA"), ["int-jira"]);
  assert.deepEqual(pinsIn(value, "other"), []);
  // Unpinning everything keeps the workspace, with no pins.
  assert.deepEqual(pinsIn(writeDock(value, "acme", []), "acme"), []);
});

test("a cookie someone wrote by hand reads as far as it makes sense", () => {
  assert.deepEqual(readDock("acme:int-sentry.today.nonsense.int-sentry,BAD SLUG:int-jira,beta"), { acme: ["int-sentry"] });
  assert.deepEqual(readDock(""), {});
  const many = Array.from({ length: 30 }, () => "int-sentry").join(".");
  assert.ok(pinsIn(`acme:${many}`, "acme").length <= MAX_APP_PINS);
});

test("pins of built-in pages from before Apps were the Marketplace's are dropped", () => {
  assert.deepEqual(pinsFrom(["usage", "int-sentry", "projects", "today", "int-sentry", "teams", "int-linear"]), ["int-sentry", "int-linear"]);
  assert.deepEqual(pinsIn("acme:projects.usage.teams", "acme"), []);
  assert.deepEqual(pinsFrom([]), []);
});

test("the account's pins win over the cookie, which is the fallback", () => {
  const cookie = writeDock(null, "acme", ["int-sentry", "int-linear"]);
  // Saved with the account, even with nothing pinned: the account's.
  assert.deepEqual(pinsToShow(["int-jira"], cookie, "acme"), ["int-jira"]);
  assert.deepEqual(pinsToShow([], cookie, "acme"), []);
  // Never saved, or identity could not be asked: this device's cookie.
  assert.deepEqual(pinsToShow(null, cookie, "acme"), ["int-sentry", "int-linear"]);
  assert.deepEqual(pinsToShow(undefined, null, "acme"), []);
});

test("a pin form pins or unpins one app", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    return data;
  };
  assert.deepEqual(appPinFromForm(form({ intent: "pin", app: "int-sentry" })), { app: "int-sentry", pinned: true });
  assert.deepEqual(appPinFromForm(form({ intent: "unpin", app: "int-sentry" })), { app: "int-sentry", pinned: false });
  assert.equal(appPinFromForm(form({ intent: "pin", app: "chat" })), null);
  assert.equal(appPinFromForm(form({ intent: "pin", app: "teams" })), null);
  assert.equal(appPinFromForm(form({ intent: "drop", app: "int-sentry" })), null);
  assert.deepEqual(withPin(["int-sentry", "int-jira"], "int-sentry", true), ["int-jira", "int-sentry"]);
  assert.deepEqual(withPin(["int-sentry", "int-jira"], "int-sentry", false), ["int-jira"]);
});

test("the cookies last a year and are secure when the site is", () => {
  assert.match(dockCookie("acme:int-sentry", true), /^g1t_dock=acme%3Aint-sentry; Path=\/; Max-Age=31536000; SameSite=Lax; Secure$/);
  assert.equal(sidebarCookie(true, false), "g1t_sidebar=closed; Path=/; Max-Age=31536000; SameSite=Lax");
  assert.equal(sidebarClosed("closed"), true);
  assert.equal(sidebarClosed("open"), false);
  assert.equal(sidebarClosed(null), false);
});
