import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_HOPS, deliveries, delivery } from "./delivery.ts";

const ship = { id: "a1", handle: "ship" };
const docs = { id: "a2", handle: "docs" };

test("a person's direct message wakes every agent in it, at hop 0", () => {
  assert.deepEqual(deliveries({ author: "user:u", hops: 3, channelKind: "dm", agents: [ship, docs], mentioned: [] }), [
    { agent_id: "a1", hops: 0 },
    { agent_id: "a2", hops: 0 },
  ]);
});

test("in a channel, a person wakes only the agent members they mention", () => {
  assert.deepEqual(deliveries({ author: "user:u", hops: 0, channelKind: "channel", agents: [ship, docs], mentioned: [] }), []);
  assert.deepEqual(
    deliveries({ author: "user:u", hops: 0, channelKind: "channel", agents: [ship, docs], mentioned: ["Ship", "nobody"] }),
    [{ agent_id: "a1", hops: 0 }],
  );
});

test("an agent wakes other agents only by mentioning them, one hop further", () => {
  // In a direct message with two agents, an agent's reply wakes nobody unless addressed.
  assert.deepEqual(deliveries({ author: "agent:a1", hops: 0, channelKind: "dm", agents: [ship, docs], mentioned: [] }), []);
  assert.deepEqual(
    deliveries({ author: "agent:a1", hops: 2, channelKind: "channel", agents: [ship, docs], mentioned: ["docs"] }),
    [{ agent_id: "a2", hops: 3 }],
  );
});

test("an agent is never handed its own message", () => {
  assert.deepEqual(
    deliveries({ author: "agent:a1", hops: 0, channelKind: "channel", agents: [ship, docs], mentioned: ["ship"] }),
    [],
  );
});

test("a chain stops at the hop limit", () => {
  const at = (hops: number) =>
    deliveries({ author: "agent:a1", hops, channelKind: "channel", agents: [ship, docs], mentioned: ["docs"] });
  assert.equal(MAX_HOPS, 6);
  assert.deepEqual(at(MAX_HOPS - 1), [{ agent_id: "a2", hops: MAX_HOPS }]);
  assert.deepEqual(at(MAX_HOPS), []);
  assert.deepEqual(at(50), []);
});

test("a delivery carries the chain's asker on g1t's own chat, and the wake's hops", () => {
  const asker = { username: "ada", role: "member", can_write: false };
  const place = { workspace: "acme", workspace_id: "w1", channel_id: "c1", channel_kind: "channel", channel_name: "ops" };
  assert.deepEqual(
    delivery(place, { agent_id: "a2", hops: 3 }, { id: "m1", thread_root: "m0" }, { hops: 2, asked_by: "u1", asker }),
    { ...place, agent_id: "a2", message_id: "m1", thread_root: "m0", asked_by: "u1", asker, hops: 3, surface: "g1t" },
  );
  // An agent that passed no asker back hands on none.
  assert.equal(delivery(place, { agent_id: "a2", hops: 1 }, { id: "m1", thread_root: null }, { hops: 0, asked_by: "u1", asker: null }).asker, null);
});
