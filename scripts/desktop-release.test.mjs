import assert from "node:assert/strict";
import { test } from "node:test";

import { classify, hostPlatform, manifest, notesName, platformOfTriple } from "./desktop-release.mjs";

test("each job's notes are named for the platforms they hold, so jobs on the same kind of machine do not overwrite each other", () => {
  const linux = [
    { platform: "linux", arch: "x64" },
    { platform: "linux", arch: "x64" },
  ];
  const windows = [{ platform: "windows", arch: "x64" }];
  assert.equal(notesName(linux), "collect-linux-x64.json");
  assert.equal(notesName(windows), "collect-windows-x64.json");
  assert.notEqual(notesName(linux), notesName(windows));
  assert.equal(notesName([...windows, ...linux]), "collect-linux-x64+windows-x64.json");
});

test("a bundle's place in a release", () => {
  assert.deepEqual(classify("g1t_0.1.0_x64-setup.exe", "windows-x64", "0.1.0"), {
    platform: "windows",
    arch: "x64",
    kind: "installer",
    name: "g1t-0.1.0-windows-x64-setup.exe",
    updater: true,
  });
  assert.deepEqual(classify("g1t.app.tar.gz", "macos-arm64", "0.1.0"), {
    platform: "macos",
    arch: "arm64",
    kind: "update",
    name: "g1t-0.1.0-macos-arm64.app.tar.gz",
    updater: true,
  });
  assert.equal(classify("g1t_0.1.0_aarch64.dmg", "macos-arm64", "0.1.0").kind, "dmg");
  assert.equal(classify("g1t_0.1.0_amd64.AppImage", "linux-x64", "0.1.0").name, "g1t-0.1.0-linux-x64.AppImage");
  assert.equal(classify("g1t_0.1.0_amd64.deb", "linux-x64", "0.1.0").updater, false);
  assert.equal(classify("g1t-0.1.0-1.x86_64.rpm", "linux-x64", "0.1.0").kind, "rpm");
  // Signatures ride with their file; an MSI is not published.
  assert.equal(classify("g1t_0.1.0_x64-setup.exe.sig", "windows-x64", "0.1.0"), null);
  assert.equal(classify("g1t_0.1.0_x64_en-US.msi", "windows-x64", "0.1.0"), null);
});

test("platforms, from a machine and from a target", () => {
  assert.equal(hostPlatform("win32", "x64"), "windows-x64");
  assert.equal(hostPlatform("darwin", "arm64"), "macos-arm64");
  assert.equal(hostPlatform("linux", "x64"), "linux-x64");
  assert.equal(platformOfTriple("x86_64-pc-windows-msvc"), "windows-x64");
  assert.equal(platformOfTriple("aarch64-apple-darwin"), "macos-arm64");
  assert.equal(platformOfTriple("debug"), null);
});

test("the manifest serves the updater and the download page", () => {
  const entries = [
    {
      platform: "windows",
      arch: "x64",
      kind: "installer",
      name: "g1t-0.1.0-windows-x64-setup.exe",
      updater: true,
      size: 10,
      sha256: "a",
      signature: "sig-win",
    },
    { platform: "macos", arch: "arm64", kind: "update", name: "g1t-0.1.0-macos-arm64.app.tar.gz", updater: true, size: 20, sha256: "b", signature: "sig-mac" },
    { platform: "macos", arch: "arm64", kind: "dmg", name: "g1t-0.1.0-macos-arm64.dmg", updater: false, size: 30, sha256: "c", signature: null },
    { platform: "linux", arch: "x64", kind: "deb", name: "g1t-0.1.0-linux-x64.deb", updater: false, size: 40, sha256: "d", signature: null },
  ];
  const m = manifest(entries, "0.1.0", { date: "2026-10-11T00:00:00.000Z", notes: "First." });
  assert.equal(m.version, "0.1.0");
  assert.equal(m.notes, "First.");
  assert.deepEqual(m.platforms, {
    "windows-x86_64": { url: "https://g1t.sh/downloads/desktop/0.1.0/g1t-0.1.0-windows-x64-setup.exe", signature: "sig-win" },
    "darwin-aarch64": { url: "https://g1t.sh/downloads/desktop/0.1.0/g1t-0.1.0-macos-arm64.app.tar.gz", signature: "sig-mac" },
  });
  // The update archive is the updater's alone; people download the disk image.
  assert.deepEqual(
    m.downloads.map((d) => d.name),
    ["g1t-0.1.0-linux-x64.deb", "g1t-0.1.0-macos-arm64.dmg", "g1t-0.1.0-windows-x64-setup.exe"],
  );
  assert.deepEqual(m.downloads[1], { platform: "macos", arch: "arm64", kind: "dmg", name: "g1t-0.1.0-macos-arm64.dmg", size: 30, sha256: "c" });
});
