import assert from "node:assert/strict";
import { test } from "node:test";

import { fromDesktopApp, launchedFromDesktopApp } from "./desktop.ts";

const request = (cookie?: string) => new Request("https://g1t.sh/", { headers: cookie ? { cookie } : {} });

test("the desktop app is known by its cookie", () => {
  assert.equal(fromDesktopApp(request("g1t_ws=acme; g1t_app=desktop")), true);
  assert.equal(fromDesktopApp(request("g1t_app=web")), false);
  assert.equal(fromDesktopApp(request()), false);
});

test("the launcher opens the site with ?app=desktop", () => {
  assert.equal(launchedFromDesktopApp(new URL("https://g1t.sh/?app=desktop")), true);
  assert.equal(launchedFromDesktopApp(new URL("https://g1t.sh/?app=other")), false);
  assert.equal(launchedFromDesktopApp(new URL("https://g1t.sh/")), false);
});
