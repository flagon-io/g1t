import assert from "node:assert/strict";
import { test } from "node:test";

import { alternateFiles, archOfHint, deviceOf, featuredFile } from "./download-platform.ts";

const UA = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  windowsArm: "Mozilla/5.0 (Windows NT 10.0; ARM64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  chromebook: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

test("a User-Agent names the visitor's platform, phones first", () => {
  assert.deepEqual(deviceOf(UA.mac), { platform: "macos", arch: null });
  assert.deepEqual(deviceOf(UA.windows), { platform: "windows", arch: "x64" });
  assert.deepEqual(deviceOf(UA.windowsArm), { platform: "windows", arch: "arm64" });
  assert.deepEqual(deviceOf(UA.linux), { platform: "linux", arch: "x64" });
  assert.deepEqual(deviceOf(UA.android), { platform: "android", arch: null });
  assert.deepEqual(deviceOf(UA.iphone), { platform: "ios", arch: "arm64" });
  assert.deepEqual(deviceOf(UA.chromebook), { platform: "linux", arch: "x64" });
  assert.deepEqual(deviceOf("curl/8.0"), { platform: null, arch: null });
  assert.deepEqual(deviceOf(null), { platform: null, arch: null });
});

test("client hints name the processor", () => {
  assert.equal(archOfHint("arm"), "arm64");
  assert.equal(archOfHint("x86"), "x64");
  assert.equal(archOfHint(""), null);
});

const files = [
  { platform: "linux", arch: "x64", kind: "appimage" },
  { platform: "linux", arch: "x64", kind: "deb" },
  { platform: "linux", arch: "x64", kind: "rpm" },
  { platform: "linux", arch: "arm64", kind: "appimage" },
  { platform: "macos", arch: "arm64", kind: "dmg" },
  { platform: "macos", arch: "x64", kind: "dmg" },
  { platform: "windows", arch: "x64", kind: "installer" },
];

test("the file offered first is the platform's preferred kind, on the visitor's processor", () => {
  assert.equal(featuredFile(files, "linux", null), files[0]);
  assert.equal(featuredFile(files, "linux", "arm64"), files[3]);
  // A Mac whose processor is not known gets Apple silicon's, and Intel's beside it.
  assert.equal(featuredFile(files, "macos", null), files[4]);
  assert.equal(featuredFile(files, "macos", "x64"), files[5]);
  assert.deepEqual(alternateFiles(files, files[4]), [files[5]]);
  // Windows on Arm has no installer of its own yet: the x64 one runs there.
  assert.equal(featuredFile(files, "windows", "arm64"), files[6]);
  assert.deepEqual(alternateFiles(files, files[0]), [files[1], files[2]]);
  // A platform the release lacks.
  assert.equal(featuredFile(files.filter((f) => f.platform !== "windows"), "windows", "x64"), null);
});
