import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PRODUCTION_IMAGE_BYTES,
  checkProductionImage,
  productionImageKey,
  productionImageOf,
  sha256,
  sniffProductionImage,
  today,
  wantsScreenshot,
} from "./production-image.ts";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0];
const WEBP = [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")];
const GIF = [...Buffer.from("GIF89a"), 0, 0, 0, 0, 0, 0];
const base64 = (bytes: number[] | Uint8Array) => Buffer.from(bytes).toString("base64");

test("a production image is a PNG, JPEG or WebP, by its bytes", () => {
  assert.equal(sniffProductionImage(Uint8Array.from(PNG)), "image/png");
  assert.equal(sniffProductionImage(Uint8Array.from(JPEG)), "image/jpeg");
  assert.equal(sniffProductionImage(Uint8Array.from(WEBP)), "image/webp");
  assert.equal(sniffProductionImage(Uint8Array.from(GIF)), null);
  assert.equal(sniffProductionImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
});

test("an upload is checked: present, at most 5 MB, and an image", () => {
  const png = checkProductionImage(base64(PNG));
  assert.ok(png.ok);
  assert.equal(png.ok && png.contentType, "image/png");
  assert.deepEqual(checkProductionImage(""), { ok: false, message: "Choose a PNG, JPEG or WebP image." });
  assert.deepEqual(checkProductionImage(null), { ok: false, message: "Choose a PNG, JPEG or WebP image." });
  assert.deepEqual(checkProductionImage("%%%"), { ok: false, message: "Choose a PNG, JPEG or WebP image." });
  assert.deepEqual(checkProductionImage(base64(GIF)), { ok: false, message: "Use a PNG, JPEG or WebP image." });
  const big = new Uint8Array(MAX_PRODUCTION_IMAGE_BYTES + 1);
  big.set(PNG);
  assert.deepEqual(checkProductionImage(base64(big)), { ok: false, message: "Use an image of at most 5 MB." });
});

test("an image is kept by its hash, apart from avatars", async () => {
  const file = await sha256(new TextEncoder().encode("abc"));
  assert.equal(file, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(productionImageKey(file), `production/${file}`);
});

test("the stored image, and whether it is preferred", () => {
  assert.equal(productionImageOf({}), null);
  assert.deepEqual(productionImageOf({ production_image: "ab", production_image_type: "image/webp", production_image_preferred: 1 }), {
    file: "ab",
    contentType: "image/webp",
    preferred: true,
  });
  assert.equal(productionImageOf({ production_image: "ab", production_image_preferred: 0 })?.preferred, false);
});

test("only production elsewhere, at an address and not shown as an upload, is visited", () => {
  const elsewhere = { runs: "elsewhere", productionUrl: "https://g1t.sh", productionImage: null };
  assert.ok(wantsScreenshot(elsewhere));
  assert.ok(wantsScreenshot({ ...elsewhere, productionImage: { preferred: false } }));
  assert.ok(!wantsScreenshot({ ...elsewhere, productionImage: { preferred: true } }));
  assert.ok(!wantsScreenshot({ ...elsewhere, productionUrl: null }));
  assert.ok(!wantsScreenshot({ ...elsewhere, runs: "g1t" }));
  assert.ok(!wantsScreenshot({ ...elsewhere, runs: null }));
});

test("the day a screenshot is versioned by", () => {
  assert.equal(today(Date.parse("2026-10-11T23:30:00Z")), "2026-10-11");
});
