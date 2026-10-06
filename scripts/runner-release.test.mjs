// node --test scripts/runner-release.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPrivateKey } from "node:crypto";

import { TARGETS, keygen, manifest, sha256, signBytes, verifyBytes, version } from "./runner-release.mjs";

test("a release is signed with the private key and checked with the raw public key", () => {
  const keys = keygen();
  assert.equal(Buffer.from(keys.public, "base64").length, 32);
  const key = createPrivateKey({ key: Buffer.from(keys.private, "base64"), format: "der", type: "pkcs8" });
  const bytes = Buffer.from('{"version":"0.2.0","files":{}}');
  const signature = signBytes(bytes, key);
  assert.equal(Buffer.from(signature, "base64").length, 64);
  assert.ok(verifyBytes(bytes, signature, keys.public));
  assert.ok(!verifyBytes(Buffer.from('{"version":"9.9.9","files":{}}'), signature, keys.public));
  assert.ok(!verifyBytes(bytes, signature, keygen().public));
});

test("the manifest names each binary that was built, with its SHA-256", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-release-"));
  try {
    writeFileSync(join(dir, TARGETS["linux-x64"].file), "linux");
    writeFileSync(join(dir, TARGETS["windows-x64"].file), "windows");
    const m = manifest(dir, "0.2.0", "example/agent:0.2.0");
    assert.equal(m.version, "0.2.0");
    assert.equal(m.agent_image, "example/agent:0.2.0");
    assert.deepEqual(Object.keys(m.files).sort(), ["linux-x64", "windows-x64"]);
    assert.equal(m.files["linux-x64"].sha256, sha256(Buffer.from("linux")));
    assert.equal(m.files["windows-x64"].name, "g1t-runner-windows-x64.exe");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("platforms are named as the runner names them", () => {
  assert.deepEqual(Object.keys(TARGETS).sort(), ["linux-arm64", "linux-x64", "macos-arm64", "macos-x64", "windows-x64"]);
  assert.match(version(), /^\d+\.\d+\.\d+/);
});
