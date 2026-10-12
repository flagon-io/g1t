import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { paxRecord, splitPath, tar, tarGz } from "./tar.ts";

const text = (value: string) => new TextEncoder().encode(value);
const SHA = "4807077b296e6edbf410d55e72749d3e1170c291";
const ROOT = "acme-rocket-4807077";
const LONG = `${ROOT}/${"deep/".repeat(40)}${"n".repeat(120)}.txt`;

const entries = [
  { path: `${ROOT}/README.md`, data: text("hello\n") },
  { path: `${ROOT}/bin/run`, data: text("#!/bin/sh\necho hi\n"), kind: "exec" as const },
  { path: `${ROOT}/latest`, data: text("README.md"), kind: "symlink" as const },
  { path: `${ROOT}/empty`, data: new Uint8Array() },
  { path: LONG, data: text("far down\n") },
  { path: `${ROOT}/${"p".repeat(90)}/${"q".repeat(90)}.md`, data: text("split\n") },
];

/** Whether `tar` can be run here. */
function hasTar(): boolean {
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("a pax record's length counts itself", () => {
  const record = new TextDecoder().decode(paxRecord("comment", text(SHA)));
  assert.equal(record, `52 comment=${SHA}\n`);
  assert.equal(record.length, 52);
  // Where adding the length's digits adds a digit.
  const value = "x".repeat(91);
  const near = new TextDecoder().decode(paxRecord("path", text(value)));
  assert.equal(Number(near.split(" ")[0]), near.length);
});

test("a long path splits into ustar's prefix and name when it can", () => {
  assert.deepEqual(splitPath(text("a/b")), { name: text("a/b"), prefix: new Uint8Array() });
  const split = splitPath(text(`${"p".repeat(90)}/${"q".repeat(90)}`))!;
  assert.equal(new TextDecoder().decode(split.prefix), "p".repeat(90));
  assert.equal(new TextDecoder().decode(split.name), "q".repeat(90));
  assert.equal(splitPath(text(`a/${"n".repeat(120)}`)), null);
  assert.equal(splitPath(text(`${"p".repeat(200)}/b`)), null);
});

test("headers are ustar, with the commit in a pax global header", () => {
  const out = tar(entries, { mtime: 1_700_000_000, comment: SHA });
  assert.equal(out.length % 512, 0);
  const decoder = new TextDecoder();
  // The global header first, as git archive writes it.
  assert.equal(decoder.decode(out.subarray(0, 17)), "pax_global_header");
  assert.equal(String.fromCharCode(out[156]!), "g");
  assert.equal(decoder.decode(out.subarray(257, 263)), "ustar\0");
  assert.equal(decoder.decode(out.subarray(512, 564)), `52 comment=${SHA}\n`);
  // Every header's checksum holds.
  const second = out.subarray(1024, 1536);
  const stored = parseInt(decoder.decode(second.subarray(148, 154)), 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : second[i]!;
  assert.equal(stored, sum);
  // Ends in two zero blocks.
  assert.ok(out.subarray(out.length - 1024).every((byte) => byte === 0));
});

test("tar reads the archive back: files, folders, modes, a symlink and long paths", { skip: !hasTar() && "no tar here" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "g1t-tar-"));
  try {
    const file = join(dir, "archive.tar.gz");
    const archive = await tarGz(entries, { mtime: 1_700_000_000, comment: SHA });
    // A gzip stream around the tar.
    assert.equal(gunzipSync(archive).length % 512, 0);
    writeFileSync(file, archive);
    const listed = execFileSync("tar", ["-tzf", file], { encoding: "utf8" }).trim().split("\n");
    assert.equal(listed[0], `${ROOT}/`);
    for (const entry of entries) assert.ok(listed.includes(entry.path), entry.path);
    assert.ok(listed.includes(`${ROOT}/bin/`));
    // One top-level folder, as actions/checkout expects.
    assert.deepEqual([...new Set(listed.map((path) => path.split("/")[0]))], [ROOT]);
    const out = join(dir, "out");
    execFileSync("mkdir", [out]);
    execFileSync("tar", ["-xzf", file, "-C", out]);
    assert.equal(readFileSync(join(out, ROOT, "README.md"), "utf8"), "hello\n");
    assert.equal(readFileSync(join(out, LONG), "utf8"), "far down\n");
    assert.equal(readFileSync(join(out, ROOT, "empty"), "utf8"), "");
    assert.equal(lstatSync(join(out, ROOT, "bin/run")).mode & 0o111, 0o111);
    assert.equal(lstatSync(join(out, ROOT, "README.md")).mode & 0o111, 0);
    assert.ok(lstatSync(join(out, ROOT, "latest")).isSymbolicLink());
    assert.equal(readlinkSync(join(out, ROOT, "latest")), "README.md");
    // Dated by the commit.
    assert.equal(Math.round(lstatSync(join(out, ROOT, "README.md")).mtimeMs / 1000), 1_700_000_000);
    // git's own reader finds the commit.
    try {
      const id = execFileSync("sh", ["-c", `gzip -dc "${file}" | git get-tar-commit-id`], { encoding: "utf8" }).trim();
      assert.equal(id, SHA);
    } catch (error) {
      if ((error as { status?: number }).status === 127) return;
      throw error;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
