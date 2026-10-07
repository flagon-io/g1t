import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";

import { crc32, zip } from "./zip";

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("a zip holds each file, deflated or stored, and reads back", async () => {
  const text = new TextEncoder().encode("hello ".repeat(200));
  const tiny = new TextEncoder().encode("x");
  const out = await zip([
    { path: "repo-main/README.md", data: text },
    { path: "repo-main/a.txt", data: tiny },
    { path: "repo-main/empty", data: new Uint8Array() },
  ]);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  // The end record names three entries and where the directory starts.
  const end = out.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 3);
  // Read each local entry back.
  let at = 0;
  const read: Record<string, string> = {};
  for (let i = 0; i < 3; i++) {
    assert.equal(view.getUint32(at, true), 0x04034b50);
    const method = view.getUint16(at + 8, true);
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(out.subarray(at + 30, at + 30 + nameLength));
    const body = out.subarray(at + 30 + nameLength, at + 30 + nameLength + size);
    read[name] = new TextDecoder().decode(method === 8 ? inflateRawSync(body) : body);
    at += 30 + nameLength + size;
  }
  assert.equal(read["repo-main/README.md"], "hello ".repeat(200));
  assert.equal(read["repo-main/a.txt"], "x");
  assert.equal(read["repo-main/empty"], "");
});
