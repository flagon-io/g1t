import assert from "node:assert/strict";
import { test } from "node:test";

import { RETRY_WAITS_MS, forward } from "./forward.ts";

/** A fetch that throws `failures` times, then answers 200; it counts its calls. */
function flaky(failures: number) {
  const calls: Request[] = [];
  const send = async (request: Request) => {
    calls.push(request);
    if (calls.length <= failures) throw new Error("Network connection lost.");
    return new Response("ok");
  };
  return { calls, send };
}

const waits: number[] = [];
const sleep = async (ms: number) => {
  waits.push(ms);
};

test("a GET that fails is tried again, and its answer comes back", async () => {
  waits.length = 0;
  const { calls, send } = flaky(2);
  const response = await forward(new Request("https://registry.npmjs.org/react"), send, sleep);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [...RETRY_WAITS_MS]);
});

test("one that keeps failing gets a 502 naming the host and why, never a throw", async () => {
  const { calls, send } = flaky(10);
  const response = await forward(new Request("https://Registry.npmjs.org:443/react"), send, sleep);
  assert.equal(calls.length, 3);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("x-g1t-egress"), "upstream-failed");
  assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
  const body = await response.text();
  assert.match(body, /registry\.npmjs\.org could not be reached/);
  assert.match(body, /Network connection lost\./);
});

test("a POST is never sent twice", async () => {
  const { calls, send } = flaky(1);
  const response = await forward(new Request("https://api.example.com/upload", { method: "POST", body: "data" }), send, sleep);
  assert.equal(calls.length, 1);
  assert.equal(response.status, 502);
});

test("an answer, even an error, is passed on as it is", async () => {
  const response = await forward(new Request("https://example.com/"), async () => new Response("no", { status: 503 }), sleep);
  assert.equal(response.status, 503);
});
