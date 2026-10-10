import assert from "node:assert/strict";
import { test } from "node:test";

import { APPS, MAX_APP_PINS, appPinFromForm, appsFor, dockCookie, isPinnable, pinsFrom, pinsIn, pinsToShow, readDock, sidebarClosed, sidebarCookie, withPin, writeDock } from "./apps.ts";

test("built-in apps are never pinned; the rest are", () => {
  for (const app of APPS) assert.equal(isPinnable(app.key), !app.builtin, app.key);
  assert.equal(isPinnable("nonsense"), false);
});

test("Code's apps are only for members with Code access", () => {
  const without = appsFor(false).map((app) => app.key);
  for (const key of ["code", "projects", "packages", "security", "context", "memory"]) assert.ok(!without.includes(key as never), key);
  for (const key of ["today", "chat", "notifications", "agents", "artifacts", "people", "workspace", "teams", "usage"]) assert.ok(without.includes(key as never), key);
  assert.equal(appsFor(true).length, APPS.length);
});

test("pins are kept per workspace, in the order they were pinned", () => {
  const value = writeDock(writeDock(null, "acme", ["projects", "usage"]), "Beta", ["teams"]);
  assert.equal(value, "beta:teams,acme:projects.usage");
  assert.deepEqual(pinsIn(value, "acme"), ["projects", "usage"]);
  assert.deepEqual(pinsIn(value, "BETA"), ["teams"]);
  assert.deepEqual(pinsIn(value, "other"), []);
  // Unpinning everything keeps the workspace, with no pins.
  assert.deepEqual(pinsIn(writeDock(value, "acme", []), "acme"), []);
});

test("a cookie someone wrote by hand reads as far as it makes sense", () => {
  assert.deepEqual(readDock("acme:projects.today.nonsense.projects,BAD SLUG:usage,beta"), { acme: ["projects"] });
  assert.deepEqual(readDock(""), {});
  const many = Array.from({ length: 30 }, () => "usage").join(".");
  assert.ok(pinsIn(`acme:${many}`, "acme").length <= MAX_APP_PINS);
});

test("pins kept with the account keep their order and only real apps", () => {
  assert.deepEqual(pinsFrom(["usage", "projects", "today", "retired-app", "usage", "teams"]), ["usage", "projects", "teams"]);
  assert.deepEqual(pinsFrom([]), []);
  assert.ok(pinsFrom(Array.from({ length: 30 }, (_, n) => APPS[8 + (n % 10)]!.key)).length <= MAX_APP_PINS);
});

test("the account's pins win over the cookie, which is the fallback", () => {
  const cookie = writeDock(null, "acme", ["projects", "usage"]);
  // Saved with the account, even with nothing pinned: the account's.
  assert.deepEqual(pinsToShow(["teams", "audit"], cookie, "acme"), ["teams", "audit"]);
  assert.deepEqual(pinsToShow([], cookie, "acme"), []);
  // Never saved, or identity could not be asked: this device's cookie.
  assert.deepEqual(pinsToShow(null, cookie, "acme"), ["projects", "usage"]);
  assert.deepEqual(pinsToShow(undefined, null, "acme"), []);
});

test("a pin form pins or unpins one app", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    return data;
  };
  assert.deepEqual(appPinFromForm(form({ intent: "pin", app: "teams" })), { app: "teams", pinned: true });
  assert.deepEqual(appPinFromForm(form({ intent: "unpin", app: "teams" })), { app: "teams", pinned: false });
  assert.equal(appPinFromForm(form({ intent: "pin", app: "chat" })), null);
  assert.equal(appPinFromForm(form({ intent: "drop", app: "teams" })), null);
  assert.deepEqual(withPin(["projects", "teams"], "projects", true), ["teams", "projects"]);
  assert.deepEqual(withPin(["projects", "teams"], "projects", false), ["teams"]);
});

test("the cookies last a year and are secure when the site is", () => {
  assert.match(dockCookie("acme:teams", true), /^g1t_dock=acme%3Ateams; Path=\/; Max-Age=31536000; SameSite=Lax; Secure$/);
  assert.equal(sidebarCookie(true, false), "g1t_sidebar=closed; Path=/; Max-Age=31536000; SameSite=Lax");
  assert.equal(sidebarClosed("closed"), true);
  assert.equal(sidebarClosed("open"), false);
  assert.equal(sidebarClosed(null), false);
});
