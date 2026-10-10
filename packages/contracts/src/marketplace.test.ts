import assert from "node:assert/strict";
import { test } from "node:test";

import { FIRST_PARTY_EXTENSIONS, type ExtensionManifest, checkManifest, dataDisclosure, extensionFrameUrl, parseListing, versionOfTag } from "./marketplace.ts";
import { isScope } from "./scopes.ts";

const published: ExtensionManifest = {
  ...FIRST_PARTY_EXTENSIONS[0]!,
  id: "standup",
  status: "available",
  source: { repo: "flagon-io/standup", tag: "v1.2.0" },
  version: "1.2.0",
};

test("g1t's own extensions are listed as coming, with manifests publishing would accept", () => {
  const ids = new Set<string>();
  for (const extension of FIRST_PARTY_EXTENSIONS) {
    assert.ok(!ids.has(extension.id), extension.id);
    ids.add(extension.id);
    assert.equal(extension.status, "soon", `${extension.id} isn't published yet`);
    assert.equal(extension.source, null);
    assert.equal(extension.pricing, null);
    assert.equal(extension.publisher.tier, "official");
    const checked = checkManifest(extension, isScope);
    assert.ok(checked.ok, `${extension.id}: ${checked.ok ? "" : checked.message}`);
  }
});

test("publishing checks a manifest strictly", () => {
  assert.ok(checkManifest(published, isScope).ok);
  const refused = (changes: Partial<ExtensionManifest> | Record<string, unknown>, why: RegExp) => {
    const checked = checkManifest({ ...published, ...changes }, isScope);
    assert.equal(checked.ok, false, JSON.stringify(changes));
    if (!checked.ok) assert.match(checked.message, why);
  };
  refused({ id: "Bad Id" }, /id/);
  refused({ scopes: ["everything:admin"] }, /scope/);
  refused({ source: null }, /source/);
  refused({ domains: ["not a host"] }, /domains/);
  refused({ runtime: "connected", domains: [] }, /declares the domains/);
  refused({ publisher: { name: "anyone", tier: "community" } }, /Community extensions run on their publisher's servers/);
  refused({ pricing: { monthly: 5 } }, /free/);
  refused({ permissions: [] }, /permissions/);
  refused({ ui: { entry: "index.html" } }, /ui.entry/);
  // A community extension that runs on its own servers, declaring them, is fine.
  assert.ok(checkManifest({ ...published, runtime: "connected", publisher: { name: "anyone", tier: "community" }, domains: ["api.example.com"] }, isScope).ok);
});

test("the install screen says where data goes", () => {
  assert.equal(dataDisclosure({ domains: [] }), "Its data stays in g1t.");
  assert.equal(dataDisclosure({ domains: ["api.acme.dev", "eu.acme.dev"] }), "Data leaves g1t to api.acme.dev, eu.acme.dev.");
});

test("an extension's page loads from the user-content origin, by version", () => {
  assert.equal(extensionFrameUrl(published, "https://g1tusercontent.com/"), "https://g1tusercontent.com/x/standup/1.2.0/index.html");
  assert.equal(extensionFrameUrl({ ...published, ui: null }, "https://g1tusercontent.com"), null);
  assert.equal(extensionFrameUrl(FIRST_PARTY_EXTENSIONS[0]!, "https://g1tusercontent.com"), null, "nothing published, nothing to load");
});

test("a tag publishes a version", () => {
  assert.equal(versionOfTag("v1.4.0"), "1.4.0");
  assert.equal(versionOfTag("2.0.0-beta.1"), "2.0.0-beta.1");
  assert.equal(versionOfTag("latest"), null);
});

test("listings are referenced by kind and id", () => {
  assert.deepEqual(parseListing("extension:on-call"), { kind: "extension", id: "on-call" });
  assert.equal(parseListing("app:on-call"), null);
});
