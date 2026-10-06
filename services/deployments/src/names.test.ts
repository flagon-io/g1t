import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// The contracts import their own modules without extensions.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".")) return next(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const { hostWorkspace, label } = await import("./names.ts");

test("a workspace named like a domain loses that hyphen in hostnames", () => {
  assert.equal(hostWorkspace("flagon-io"), "flagonio");
  assert.equal(hostWorkspace("acme-co-uk"), "acmecouk");
  assert.equal(hostWorkspace("Big-Corp-COM"), "big-corpcom");
  // Nothing that only looks like one.
  assert.equal(hostWorkspace("syntaqx"), "syntaqx");
  assert.equal(hostWorkspace("io"), "io");
  assert.equal(hostWorkspace("acme-labs"), "acme-labs");
});

test("an app's name uses that spelling, so no label reads as another site", async () => {
  assert.equal(await label("flagon-io", "automation-lab", null), "automation-lab-flagonio");
  assert.equal(await label("flagon-io", "web", "fix/login"), "web-git-fix-login-flagonio");
  assert.equal(await label("syntaqx", "hello", null), "hello-syntaqx");
});
