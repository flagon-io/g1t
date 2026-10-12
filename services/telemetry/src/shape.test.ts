import assert from "node:assert/strict";
import test from "node:test";

import { fingerprint, messageShape, topFrame } from "./errors.ts";
import { bucketOf, decode, encode, percentiles, quantile } from "./histogram.ts";
import { hexId, nanosToMicros, route, severityNumber, severityOf } from "./shape.ts";

test("routes lose their ids, keep their words", () => {
  assert.equal(route("/users/42/posts"), "/users/:id/posts");
  assert.equal(route("/o/3f2504e0-4f89-11d3-9a0c-0305e82c3301?x=1"), "/o/:id");
  assert.equal(route("/blob/4bf92f3577b34da6a3ce/readme"), "/blob/:id/readme");
  assert.equal(route("/assets/app.css"), "/assets/app.css");
  assert.equal(route("/"), "/");
  assert.equal(route("/settings/profile"), "/settings/profile");
});

test("severities", () => {
  assert.equal(severityOf(severityNumber("warn")), "warn");
  assert.equal(severityOf(severityNumber("log")), "info");
  assert.equal(severityOf(severityNumber("CRITICAL")), "fatal");
  assert.equal(severityOf(0), "info");
  assert.equal(severityOf(3), "trace");
});

test("ids and times", () => {
  assert.equal(hexId("AAAAAAAAAAAAAAAAAAAAAA==", 32), null);
  assert.equal(hexId("S/kvNXezTaajzpKdDg5HNg==", 32), "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(hexId("ABCDEF0123456789", 16), "abcdef0123456789");
  assert.equal(nanosToMicros("1760000000123456789"), 1_760_000_000_123_456);
  assert.equal(nanosToMicros("0"), null);
});

test("percentiles come from bucket counts, within a bucket of the truth", () => {
  const counts = decode("");
  for (let i = 1; i <= 100; i++) counts[bucketOf(i)]++;
  const p = percentiles(counts);
  assert.ok(p.p50! >= 30 && p.p50! <= 75, `p50 ${p.p50}`);
  assert.ok(p.p99! >= 75 && p.p99! <= 100, `p99 ${p.p99}`);
  assert.deepEqual(decode(encode(counts)), counts);
  assert.equal(quantile(decode(""), 0.5), null);
});

test("the same error thrown with different ids is one group", async () => {
  const a = await fingerprint("TypeError", "Cannot read 'name' of user 41", "TypeError\n    at load (src/user.ts:10:5)", "api");
  const b = await fingerprint("TypeError", "Cannot read 'email' of user 977", "TypeError\n    at load (src/user.ts:12:9)", "api");
  const c = await fingerprint("TypeError", "Cannot read 'name' of user 41", "TypeError\n    at save (src/user.ts:10:5)", "api");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(messageShape('fetch https://x.y/z failed with 503 for "abc"'), 'fetch <url> failed with # for "…"');
  assert.equal(topFrame("Error\n    at f (node_modules/lib/index.js:1:1)\n    at g (src/app.ts:4:2)"), "g src/app.ts");
});
