import assert from "node:assert/strict";
import { test } from "node:test";

import { StreamUsage, fromUsage, measure, total } from "./usage.ts";

const sse = (events: object[]) => events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");

test("a stream's tokens come from message_start and the last message_delta", () => {
  const stream = sse([
    { type: "message_start", message: { usage: { input_tokens: 12, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300, output_tokens: 1 } } },
    { type: "content_block_delta", delta: { text: "hi" } },
    { type: "message_delta", usage: { output_tokens: 40 } },
    { type: "message_delta", usage: { output_tokens: 95 } },
    { type: "message_stop" },
  ]);
  const usage = new StreamUsage();
  // Split mid-line, as chunks arrive.
  usage.push(stream.slice(0, 37));
  usage.push(stream.slice(37));
  assert.deepEqual(usage.finish(), { input: 12, output: 95, cacheRead: 4000, cacheWrite: 300 });
});

test("a whole answer's usage, and nonsense counted as nothing", () => {
  assert.deepEqual(fromUsage({ input_tokens: 5, output_tokens: 7 }), { input: 5, output: 7, cacheRead: 0, cacheWrite: 0 });
  assert.equal(total(fromUsage({ input_tokens: -3, output_tokens: Number.NaN })), 0);
  const usage = new StreamUsage();
  usage.push("data: {not json\n\ndata: [DONE]\n");
  assert.equal(total(usage.finish()), 0);
});

test("measuring passes the answer through unchanged", async () => {
  const body = sse([{ type: "message_start", message: { usage: { input_tokens: 3 } } }, { type: "message_delta", usage: { output_tokens: 9 } }]);
  const { response, tokens } = measure(new Response(body, { headers: { "content-type": "text/event-stream" } }));
  assert.equal(await response.text(), body);
  assert.deepEqual(await tokens, { input: 3, output: 9, cacheRead: 0, cacheWrite: 0 });
  const json = measure(new Response(JSON.stringify({ usage: { input_tokens: 2, output_tokens: 1 } }), { headers: { "content-type": "application/json" } }));
  assert.equal(JSON.parse(await json.response.text()).usage.input_tokens, 2);
  assert.equal(total(await json.tokens), 3);
  const failed = measure(new Response("no", { status: 500 }));
  assert.equal(failed.response.status, 500);
  assert.equal(total(await failed.tokens), 0);
});
