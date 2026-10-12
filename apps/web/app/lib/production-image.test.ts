import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_PRODUCTION_IMAGE_BYTES,
  cardSources,
  externalTarget,
  externalVersion,
  productionImageUrl,
  readProductionImageUpload,
  utcDay,
} from "./production-image.ts";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const GIF = [...new TextEncoder().encode("GIF89a"), 0, 0, 0, 0, 0, 0];

function form(bytes: number[] | Uint8Array | null, type = "image/png"): FormData {
  const data = new FormData();
  if (bytes) data.set("image", new File([Uint8Array.from(bytes)], "shot.png", { type }));
  return data;
}

test("an uploaded image is served from the usercontent origin by its hash", () => {
  assert.equal(productionImageUrl("ab12", "https://g1tusercontent.com"), "https://g1tusercontent.com/production-images/ab12");
  assert.equal(productionImageUrl("ab12"), "/production-images/ab12");
});

test("an upload is a PNG, JPEG or WebP of at most 5 MB, read by its bytes", async () => {
  const ok = await readProductionImageUpload(form(PNG));
  assert.ok("image" in ok);
  assert.deepEqual(await readProductionImageUpload(form(null)), { error: "Choose an image to upload." });
  assert.deepEqual(await readProductionImageUpload(form(GIF, "image/gif")), { error: "Use a PNG, JPEG or WebP image." });
  // Named a PNG, but it is not one.
  assert.deepEqual(await readProductionImageUpload(form([1, 2, 3, 4])), { error: "Use a PNG, JPEG or WebP image." });
  const big = new Uint8Array(MAX_PRODUCTION_IMAGE_BYTES + 1);
  big.set(PNG);
  assert.deepEqual(await readProductionImageUpload(form(big)), { error: "Use an image of at most 5 MB." });
});

const now = Date.parse("2026-10-11T12:00:00Z");
const elsewhere = { kind: "app", runs: "elsewhere", productionUrl: "https://g1t.sh", productionImage: null };
const reported = { url: "https://app.example.com", sha: "ABC1234DEF5678ABC1234DEF5678ABC1234DEF56", created_at: "2026-10-11T10:00:00Z" };

test("production elsewhere is taken at its address, versioned by the day", () => {
  assert.deepEqual(externalTarget(elsewhere, null, now), { url: "https://g1t.sh", commit: "2026-10-11", since: null });
  assert.equal(utcDay(now), "2026-10-11");
});

test("a reported production deployment gives the address and the commit", () => {
  assert.deepEqual(externalTarget(elsewhere, reported, now), {
    url: "https://app.example.com",
    commit: reported.sha.toLowerCase(),
    since: reported.created_at,
  });
  // No address of its own: the project's.
  assert.equal(externalTarget(elsewhere, { ...reported, url: null }, now)?.url, "https://g1t.sh");
  // An app nobody said runs where, reporting production, runs elsewhere.
  assert.equal(externalTarget({ ...elsewhere, runs: null, productionUrl: null }, reported, now)?.url, "https://app.example.com");
});

test("no screenshot when it is not elsewhere, has no address, or shows an upload", () => {
  assert.equal(externalTarget({ ...elsewhere, runs: "g1t" }, null, now), null);
  assert.equal(externalTarget({ ...elsewhere, runs: null }, null, now), null);
  assert.equal(externalTarget({ ...elsewhere, runs: null, kind: "library" }, reported, now), null);
  assert.equal(externalTarget({ ...elsewhere, productionUrl: null }, null, now), null);
  assert.equal(externalTarget({ ...elsewhere, productionUrl: "ftp://g1t.sh" }, null, now), null);
  assert.equal(externalTarget({ ...elsewhere, productionImage: { preferred: true } }, reported, now), null);
});

test("a version changes with the deploy or the day", () => {
  assert.equal(externalVersion({ url: "https://g1t.sh", commit: "2026-10-11", since: null }), "2026-10-11-0");
  assert.equal(
    externalVersion({ url: "https://g1t.sh", commit: "abc1234", since: "2026-10-11T10:00:00Z" }),
    `abc1234-${Date.parse("2026-10-11T10:00:00Z")}`,
  );
});

test("the card tries the screenshot, then the upload; a preferred upload alone", () => {
  const upload = { url: "https://g1tusercontent.com/production-images/ab", preferred: false };
  const shot = { src: "/a/b/production.jpg", kind: "screenshot" };
  const uploaded = { src: upload.url, kind: "upload" };
  assert.deepEqual(cardSources("/a/b/production.jpg", upload), [shot, uploaded]);
  assert.deepEqual(cardSources("/a/b/production.jpg", { ...upload, preferred: true }), [uploaded]);
  assert.deepEqual(cardSources(null, upload), [uploaded]);
  assert.deepEqual(cardSources("/a/b/production.jpg", null), [shot]);
  assert.deepEqual(cardSources(null, null), []);
});
