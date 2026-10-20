import assert from "node:assert/strict";
import { test } from "node:test";

import { chatClient } from "@g1t/contracts/chat";

import { fromInternet, internalAnswer, type InternalChat } from "./internal.ts";

function service() {
  const calls: string[] = [];
  const chat: InternalChat = {
    internalG1tPost: async () => (calls.push("post"), { ok: true, value: null }),
    internalG1tEdit: async () => (calls.push("edit"), { ok: true, value: null }),
  };
  return { chat, calls };
}

const call = (headers: Record<string, string> = {}) =>
  new Request("https://service/internal/g1t_post", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });

test("posting as g1t is refused for anything that came in from the internet", async () => {
  for (const header of ["cf-connecting-ip", "x-real-ip", "x-forwarded-for"]) {
    const { chat, calls } = service();
    const response = await internalAnswer(chat, call({ [header]: "203.0.113.9" }), "g1t_post");
    assert.equal(response.status, 403, header);
    assert.deepEqual(calls, []);
  }
});

test("a service binding's call posts and edits as g1t; anything else is not found", async () => {
  const { chat, calls } = service();
  assert.equal(fromInternet(call()), false);
  assert.equal((await internalAnswer(chat, call(), "g1t_post")).status, 200);
  assert.equal((await internalAnswer(chat, call(), "g1t_edit")).status, 200);
  assert.equal((await internalAnswer(chat, call(), "post")).status, 404);
  assert.deepEqual(calls, ["post", "edit"]);
});

test("the site's chat client never reaches the internal methods", async () => {
  const urls: string[] = [];
  const binding = { fetch: async (url: string) => (urls.push(String(url)), Response.json({ ok: true, value: null })) };
  const client = chatClient(binding as never);
  const viewer = { id: "u1", username: "ana", workspaces: [{ slug: "acme", role: "member" as const }] };
  await client.post("acme", "chn_1", viewer as never, { body: "hi" });
  await client.g1tDm("acme", viewer as never);
  await client.g1tAsk("acme", viewer as never, { body: "What happened?" });
  await client.g1tReset("acme", "chn_1", viewer as never);
  await client.g1tRetry("acme", "chn_1", viewer as never);
  await client.g1tStop("acme", "chn_1", viewer as never);
  assert.ok(
    urls.every((url) => url.startsWith("https://service/rpc/")),
    urls.join(" "),
  );
});
