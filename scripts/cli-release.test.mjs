// node --test scripts/cli-release.test.mjs
import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { TARGETS, manifest, sha256, version } from "./cli-release.mjs";
import { keygen, signBytes, verifyBytes } from "./runner-release.mjs";

test("the version is crates/g1t's", () => {
  assert.match(version(), /^\d+\.\d+\.\d+/);
});

test("the manifest and SHA256SUMS name each binary that was built", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-release-"));
  try {
    writeFileSync(join(dir, TARGETS["linux-x64"].file), "linux");
    writeFileSync(join(dir, TARGETS["windows-x64"].file), "windows");
    const m = manifest(dir, "0.2.0", new Date("2026-10-12T00:00:00Z"));
    assert.deepEqual(m, {
      version: "0.2.0",
      published_at: "2026-10-12T00:00:00.000Z",
      files: {
        "linux-x64": { name: "g1t-linux-x64", sha256: sha256("linux") },
        "windows-x64": { name: "g1t-windows-x64.exe", sha256: sha256("windows") },
      },
    });
    // The install scripts read `<sha256>  <name>` lines.
    assert.equal(
      readFileSync(join(dir, "SHA256SUMS"), "utf8"),
      `${sha256("linux")}  g1t-linux-x64\n${sha256("windows")}  g1t-windows-x64.exe\n`,
    );
    assert.equal(readFileSync(join(dir, "latest.json"), "utf8"), readFileSync(join(dir, "manifest.json"), "utf8"));
    const keys = keygen();
    const key = createPrivateKey({ key: Buffer.from(keys.private, "base64"), format: "der", type: "pkcs8" });
    const bytes = readFileSync(join(dir, "latest.json"));
    assert.ok(verifyBytes(bytes, signBytes(bytes, key), keys.public));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a manifest of nothing is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-release-"));
  try {
    assert.throws(() => manifest(dir, "0.2.0"), /no binaries/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
