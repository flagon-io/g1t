import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_AVATAR_BYTES, readAvatarUpload, sniffImage, toBase64 } from "./avatar-upload.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const text = (value: string) => new TextEncoder().encode(value);

function form(bytes: Uint8Array, name = "icon.png", type = "image/png"): FormData {
  const data = new FormData();
  data.set("avatar", new File([bytes], name, { type }));
  return data;
}

test("an image is known by its bytes", () => {
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(JPEG), "image/jpeg");
  assert.equal(sniffImage(text("GIF89a\x01\x00")), "image/gif");
  assert.equal(sniffImage(text("RIFF\x24\x00\x00\x00WEBPVP8 ")), "image/webp");
});

test("SVG and anything else is refused, whatever it is called", async () => {
  assert.equal(sniffImage(text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(sniffImage(text("RIFF\x00\x00\x00\x00WAVEfmt ")), null);
  const disguised = await readAvatarUpload(form(text("<svg onload=alert(1)/>"), "icon.png", "image/png"));
  assert.ok("error" in disguised);
});

test("more than a megabyte is refused", async () => {
  const big = new Uint8Array(MAX_AVATAR_BYTES + 1);
  big.set(PNG);
  const result = await readAvatarUpload(form(big));
  assert.deepEqual(result, { error: "Use an image of at most 1 MB." });
  const exact = new Uint8Array(MAX_AVATAR_BYTES);
  exact.set(PNG);
  const fits = await readAvatarUpload(form(exact));
  assert.ok("image" in fits);
});

test("an image is sent as base64", async () => {
  const result = await readAvatarUpload(form(PNG));
  assert.deepEqual(result, { image: toBase64(PNG) });
  assert.equal(Buffer.from(toBase64(PNG), "base64").compare(Buffer.from(PNG)), 0);
});

test("a missing file is asked for", async () => {
  assert.deepEqual(await readAvatarUpload(new FormData()), { error: "Choose an image to upload." });
});
