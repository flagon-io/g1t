import assert from "node:assert/strict";
import { test } from "node:test";

import { type DesktopSettingsView, KEPT, checkFailed, hostOf, sectionOf, settingsOf, stayed, updateLine } from "./desktop-settings.ts";

function view(over: Partial<DesktopSettingsView> = {}): DesktopSettingsView {
  return {
    startHidden: true,
    closeToTray: true,
    notifications: true,
    flash: true,
    badge: true,
    systemTitleBar: false,
    zoom: 1.1,
    developerTools: false,
    autoUpdate: true,
    runner: true,
    runnerBackend: "sandboxed",
    runnerWorkspace: "acme",
    runnerCapabilities: { linux: true, windows: false, macos: true },
    openAtLogin: true,
    version: "0.3.6",
    platform: "windows",
    server: "https://g1t.sh/",
    updateReady: null,
    checkedAt: null,
    titleBarChanged: false,
    customFrame: true,
    developerToolsChanged: false,
    runnerView: {} as DesktopSettingsView["runnerView"],
    ...over,
  };
}

test("a change is saved over the settings as the app has them, and nothing else", () => {
  // The zoom changed from the menu while the dialog was open: turning the badge off keeps it.
  const saved = settingsOf(view({ zoom: 1.5 }), { badge: false });
  assert.equal(saved.badge, false);
  assert.equal(saved.zoom, 1.5);
  assert.deepEqual(saved.runnerCapabilities, { linux: true, windows: false, macos: true });
  // Only what the app keeps goes back: not what it only shows.
  assert.deepEqual(Object.keys(saved).sort(), [...KEPT].sort());
});

test("the app opens the section it names, or the first", () => {
  assert.equal(sectionOf("updates"), "updates");
  assert.equal(sectionOf("runner"), "runner");
  assert.equal(sectionOf("plan9"), "general");
  assert.equal(sectionOf(null), "general");
});

test("updates say where this copy stands", () => {
  assert.match(updateLine(view({ updateReady: "0.3.7" })), /^Version 0\.3\.7 is downloaded/);
  assert.match(updateLine(view({ checkedAt: Date.now() })), /^Up to date\. Last checked today at /);
  assert.match(updateLine(view()), /checks on its own shortly/);
  assert.equal(updateLine(view({ autoUpdate: false })), "Checking on its own is off.");
});

test("a restart says Restarting until g1t goes, unless the person kept it open", () => {
  assert.equal(stayed("stayed"), true);
  assert.equal(stayed("restarting"), false);
  // An app from before it answered.
  assert.equal(stayed(undefined), false);
});

test("a failed check says why in a line", () => {
  assert.match(checkFailed("error sending request for url"), /Could not reach g1t\.sh/);
  assert.match(checkFailed(new Error("")), /Could not reach g1t\.sh/);
  assert.equal(checkFailed("the signature is wrong"), "Could not check: the signature is wrong");
  assert.equal(hostOf("https://g1t.example.com/"), "g1t.example.com");
});
