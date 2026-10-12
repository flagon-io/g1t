import assert from "node:assert/strict";
import { test } from "node:test";

import { BUFFERED_MAX_BYTES, RETRY_WAITS_MS, bufferable, forward } from "./forward.ts";

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

/** A tarball's answer whose body breaks off after its first chunk, as an upstream that drops mid-body does. */
function brokenOff(length: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(16));
      controller.error(new Error("aborted"));
    },
  });
  return new Response(body, { headers: { "content-length": String(length), "content-type": "application/octet-stream" } });
}

test("a body that breaks off midway is tried again, and the whole answer comes back", async () => {
  let calls = 0;
  const send = async () => {
    calls += 1;
    return calls === 1 ? brokenOff(1024) : new Response(new Uint8Array(1024), { headers: { "content-length": "1024" } });
  };
  const response = await forward(new Request("https://registry.npmjs.org/react/-/react-19.0.0.tgz"), send, sleep);
  assert.equal(calls, 2);
  assert.equal(response.status, 200);
  assert.equal((await response.arrayBuffer()).byteLength, 1024);
});

test("a body that keeps breaking off ends as a 502, not a truncated answer", async () => {
  let calls = 0;
  const response = await forward(
    new Request("https://registry.npmjs.org/x.tgz"),
    async () => {
      calls += 1;
      return brokenOff(1024);
    },
    sleep,
  );
  assert.equal(calls, 3);
  assert.equal(response.status, 502);
});

test("large, compressed or unsized answers stream as they come", () => {
  const sized = (length: number, headers: Record<string, string> = {}) => new Response("x", { headers: { "content-length": String(length), ...headers } });
  assert.equal(bufferable(sized(1024)), true);
  assert.equal(bufferable(sized(BUFFERED_MAX_BYTES + 1)), false);
  assert.equal(bufferable(sized(1024, { "content-encoding": "gzip" })), false);
  assert.equal(bufferable(new Response(new ReadableStream())), false);
  assert.equal(bufferable(new Response(null, { status: 304 })), false);
});
