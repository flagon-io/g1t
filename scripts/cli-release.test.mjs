// node --test scripts/cli-release.test.mjs
import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BUILDER, TARGETS, builderArgs, builderScript, manifest, sha256, version } from "./cli-release.mjs";
import { keygen, signBytes, verifyBytes } from "./runner-release.mjs";

test("a workflow's build uses the job's Cargo registry, which the crates cache restores", () => {
  const job = builderArgs({ root: "/home/runner/work/repo", env: { GITHUB_ACTIONS: "true" }, home: "/home/node" });
  assert.ok(job.includes("/home/node/.cargo/registry:/usr/local/cargo/registry"), job.join(" "));
  assert.ok(job.includes("/home/runner/work/repo:/src"));
  assert.equal(job.at(-1), BUILDER);
  // Elsewhere a Docker volume keeps it.
  assert.ok(builderArgs({ root: "/x", env: {}, home: "/h" }).includes("g1t-cargo-registry:/usr/local/cargo/registry"));
  // The release key's public half goes into the build, for `g1t upgrade`; without it, nothing is passed.
  assert.ok(builderArgs({ root: "/x", env: { G1T_RUNNER_RELEASE_KEY: "pub=" }, home: "/h" }).includes("G1T_RUNNER_RELEASE_KEY=pub="));
  assert.ok(!builderArgs({ root: "/x", env: {}, home: "/h" }).some((arg) => arg.includes("RELEASE_KEY")));
  // What the container wrote as root goes back to the user, even when the build fails.
  const script = builderScript("x86_64-unknown-linux-musl", "1000:1000");
  assert.match(script, /^trap 'chown -R 1000:1000 \/src\/target\/zig \/usr\/local\/cargo\/registry' EXIT; set -e;/);
  assert.ok(!builderScript("t", null).includes("chown"));
});

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
