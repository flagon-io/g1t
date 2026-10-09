import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentDelivery } from "@g1t/contracts";

import { g1tSurface } from "./surface.ts";

const delivery: AgentDelivery = {
  workspace: "acme",
  workspace_id: "wsp_1",
  channel_id: "chn_1",
  channel_kind: "channel",
  channel_name: "releases",
  agent_id: "agt_ship",
  message_id: "msg_1",
  thread_root: "msg_0",
  asked_by: "usr_dana",
  hops: 2,
  asker: { username: "dana", role: "member", can_write: false },
  surface: "g1t",
};

/** A chat binding that records each call and answers `answers[method]`. */
function fakeChat(answers: Record<string, unknown>) {
  const calls: { method: string; body: any }[] = [];
  const binding = {
    async fetch(url: string, init: { body: string }) {
      const method = new URL(url).pathname.replace("/rpc/", "");
      calls.push({ method, body: JSON.parse(init.body) });
      return Response.json(answers[method] ?? { ok: true, value: null });
    },
  };
  return { binding: binding as any, calls };
}

test("the g1t adapter posts in the thread, handing on hops, asked_by and the asker's access", async () => {
  const chat = fakeChat({ post_as_agent: { ok: true, value: { id: "msg_2" } } });
  const id = await g1tSurface(chat.binding, delivery).post("Tagged 1.4.");
  assert.equal(id, "msg_2");
  const [call] = chat.calls;
  assert.equal(call.method, "post_as_agent");
  assert.equal(call.body.agent_id, "agt_ship");
  assert.equal(call.body.channel_id, "chn_1");
  assert.deepEqual(call.body.message, {
    body: "Tagged 1.4.",
    thread_root: "msg_0",
    hops: 2,
    asked_by: "usr_dana",
    asker: { username: "dana", role: "member", can_write: false },
  });
});

test("the g1t adapter reads the thread as the agent, and leaves out deleted messages", async () => {
  const message = (id: string, deleted: string | null) => ({
    id,
    channel_id: "chn_1",
    author: { kind: "user", id: "usr_dana", name: "dana", display_name: "Dana", avatar: null, role: null },
    kind: "text",
    body: "hi",
    card: null,
    thread_root: "msg_0",
    reply_count: 0,
    last_reply_at: null,
    created_at: "2026-10-08T12:00:00Z",
    edited_at: null,
    deleted_at: deleted,
  });
  const chat = fakeChat({ history_for_agent: { ok: true, value: [message("msg_0", null), message("msg_1", "2026-10-08T12:01:00Z")] } });
  const history = await g1tSurface(chat.binding, delivery).history(30);
  assert.deepEqual(chat.calls[0].body, { workspace: "acme", channel_id: "chn_1", agent_id: "agt_ship", thread_root: "msg_0", limit: 30 });
  assert.deepEqual(history.map((m) => m.id), ["msg_0"]);
  assert.equal(history[0].author.name, "dana");
});

test("a failed post is an error the reply loop records; typing never throws", async () => {
  const chat = fakeChat({ post_as_agent: { ok: false, error: { code: "forbidden", message: "not a member" } } });
  await assert.rejects(g1tSurface(chat.binding, delivery).post("x"), /not a member/);
  const broken = { fetch: async () => new Response("down", { status: 500 }) } as any;
  await g1tSurface(broken, delivery).typing();
});
