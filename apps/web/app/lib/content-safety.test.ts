import assert from "node:assert/strict";
import { test } from "node:test";

import { contentDisposition, hardenRegistryHeaders, NOTHING_RUNS, opensAsDocument } from "./content-safety.ts";

test("publisher documents a browser would open are downloads", () => {
  for (const type of [
    "application/xml",
    "text/xml; charset=utf-8",
    "application/xhtml+xml",
    "text/html",
    "image/svg+xml",
    "application/vnd.example+xml",
    "text/javascript",
    "",
    null,
  ]) {
    assert.equal(opensAsDocument(type), true, String(type));
  }
});

test("data types stay inline", () => {
  for (const type of [
    "application/json",
    "text/plain; charset=utf-8",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.npm.install-v1+json",
    "application/octet-stream",
    "application/java-archive",
    "application/gzip",
    "image/png",
  ]) {
    assert.equal(opensAsDocument(type), false, type);
  }
});

test("every registry answer runs nothing and is never sniffed", () => {
  const pom = new Headers({ "content-type": "application/xml" });
  hardenRegistryHeaders(pom);
  assert.equal(pom.get("x-content-type-options"), "nosniff");
  assert.equal(pom.get("content-security-policy"), NOTHING_RUNS);
  assert.equal(pom.get("content-disposition"), "attachment");

  const json = new Headers({ "content-type": "application/json" });
  hardenRegistryHeaders(json);
  assert.equal(json.get("content-security-policy"), NOTHING_RUNS);
  assert.equal(json.get("content-disposition"), null);

  const named = new Headers({ "content-type": "text/html", "content-disposition": 'attachment; filename="a.html"' });
  hardenRegistryHeaders(named);
  assert.equal(named.get("content-disposition"), 'attachment; filename="a.html"');
});

test("download names keep quotes and control characters out of the header", () => {
  assert.equal(contentDisposition("web-main.zip"), `attachment; filename="web-main.zip"; filename*=UTF-8''web-main.zip`);
  const sly = contentDisposition('web-a"b\r\nSet-Cookie: x.zip');
  assert.ok(!/[\r\n]/.test(sly));
  assert.match(sly, /^attachment; filename="web-a_b__Set-Cookie: x.zip"; filename\*=UTF-8''web-a%22b__Set-Cookie%3A%20x.zip$/);
  assert.match(contentDisposition("café.zip"), /filename="caf_.zip"; filename\*=UTF-8''caf%C3%A9.zip$/);
});
