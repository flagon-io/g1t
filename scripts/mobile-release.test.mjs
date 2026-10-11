import assert from "node:assert/strict";
import { test } from "node:test";

import { apkName, manifestFor, newestBuild, version } from "./mobile-release.mjs";

test("the version is the app's, and the APK is named by it", () => {
  assert.match(version(), /^\d+\.\d+\.\d+$/);
  assert.equal(apkName("0.2.0"), "g1t-0.2.0-android.apk");
});

test("the manifest lists the APK with its size and SHA-256, and SHA256SUMS matches", () => {
  const { manifest, sums } = manifestFor({
    version: "0.2.0",
    build: 7,
    notes: "",
    files: [{ name: "g1t-0.2.0-android.apk", size: 42, sha256: "ab".repeat(32) }],
    now: new Date("2026-10-11T00:00:00Z"),
  });
  assert.deepEqual(manifest, {
    version: "0.2.0",
    build: 7,
    pub_date: "2026-10-11T00:00:00.000Z",
    notes: undefined,
    downloads: [{ platform: "android", kind: "apk", name: "g1t-0.2.0-android.apk", size: 42, sha256: "ab".repeat(32) }],
  });
  assert.equal(sums, `${"ab".repeat(32)}  g1t-0.2.0-android.apk\n`);
});

test("the newest finished build with an APK is the one fetched", () => {
  const list = [
    { id: "a", status: "FINISHED", createdAt: "2026-10-10T00:00:00Z", artifacts: { buildUrl: "https://x/a.apk" } },
    { id: "b", status: "ERRORED", createdAt: "2026-10-12T00:00:00Z", artifacts: {} },
    { id: "c", status: "FINISHED", createdAt: "2026-10-11T00:00:00Z", artifacts: { buildUrl: "https://x/c.apk" } },
  ];
  assert.equal(newestBuild(list)?.id, "c");
  assert.equal(newestBuild([]), null);
  assert.equal(newestBuild(null), null);
});
