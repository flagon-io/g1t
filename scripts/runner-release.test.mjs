// node --test scripts/runner-release.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPrivateKey } from "node:crypto";

import { TARGETS, keygen, manifest, sha256, signBytes, verifyBytes, version } from "./runner-release.mjs";
import { sandboxFiles, section } from "./sandbox-image.mjs";

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

test("the sandbox's images join the signed manifest, and one that is missing is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-release-sandbox-"));
  try {
    writeFileSync(join(dir, TARGETS["linux-x64"].file), "linux");
    writeFileSync(join(dir, sandboxFiles("x64")["wsl-x64"]), "rootfs");
    const s = await section(dir, "g1t.sh/flagon-io/g1t-runner@sha256:ab");
    assert.deepEqual(Object.keys(s.files), ["wsl-x64"]);
    assert.equal(s.files["wsl-x64"].sha256, sha256(Buffer.from("rootfs")));
    assert.equal(s.files["wsl-x64"].size, 6);
    writeFileSync(join(dir, "sandbox.json"), JSON.stringify(s));
    const m = manifest(dir, "0.3.0");
    assert.equal(m.sandbox.runner_image, "g1t.sh/flagon-io/g1t-runner@sha256:ab");
    assert.equal(m.sandbox.files["wsl-x64"].name, "g1t-sandbox-wsl-x64.tar.gz");
    writeFileSync(join(dir, "sandbox.json"), JSON.stringify({ runner_image: null, files: { "vm-x64-disk": { name: "gone.raw.gz", sha256: "00" } } }));
    assert.throws(() => manifest(dir, "0.3.0"), /gone\.raw\.gz/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the sandbox's files are named as the launcher asks for them", () => {
  // crates/runner/src/selfhosted/launcher: wsl.rs's and vm.rs's image_keys().
  assert.deepEqual(Object.keys(sandboxFiles("arm64")), ["wsl-arm64", "vm-arm64-kernel", "vm-arm64-initrd", "vm-arm64-disk"]);
});
