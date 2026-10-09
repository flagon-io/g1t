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
    delivery(place, { agent_id: "a2", hops: 3 }, { id: "m1", thread_root: "m0" }, { hops: 2, asked_by: "u1", asker, chain: ["a1"] }),
    { ...place, agent_id: "a2", message_id: "m1", thread_root: "m0", asked_by: "u1", asker, chain: ["a1"], hops: 3, surface: "g1t" },
  );
  // An agent that passed no asker back hands on none.
  assert.equal(delivery(place, { agent_id: "a2", hops: 1 }, { id: "m1", thread_root: null }, { hops: 0, asked_by: "u1", asker: null, chain: [] }).asker, null);
});

test("mentioning @g1t in a channel brings it in once; never into a DM", async () => {
  const { addsOrchestrator } = await import("./delivery.ts");
  assert.equal(addsOrchestrator({ channelKind: "channel", mentioned: ["G1T"], orchestratorIsMember: false }), true);
  assert.equal(addsOrchestrator({ channelKind: "channel", mentioned: ["g1t"], orchestratorIsMember: true }), false, "already in");
  assert.equal(addsOrchestrator({ channelKind: "channel", mentioned: ["ship"], orchestratorIsMember: false }), false);
  assert.equal(addsOrchestrator({ channelKind: "dm", mentioned: ["g1t"], orchestratorIsMember: false }), false);
  // Once in, it is woken like any mentioned agent member.
  const g1t = { id: "a9", handle: "g1t" };
  assert.deepEqual(deliveries({ author: "user:u", hops: 0, channelKind: "channel", agents: [ship, g1t], mentioned: ["g1t"] }), [{ agent_id: "a9", hops: 0 }]);
});

test("no ping-pong: an agent's message never goes back to the agent that sent it the work", async () => {
  const { chainFor, sender } = await import("./delivery.ts");
  const g1t = { id: "a9", handle: "g1t" };
  // g1t handed the work to ship; ship's reply mentions g1t and docs.
  const chain = chainFor(["a9"], "a1");
  assert.deepEqual(chain, ["a9", "a1"]);
  assert.equal(sender(chain), "a9");
  assert.deepEqual(
    deliveries({ author: "agent:a1", hops: 1, channelKind: "channel", agents: [ship, docs, g1t], mentioned: ["g1t", "docs"], notTo: sender(chain) }),
    [{ agent_id: "a2", hops: 2 }],
  );
  assert.deepEqual(chainFor("nonsense", "a1"), ["a1"]);
  assert.equal(sender(["a1"]), null, "a person sent it");
});

test("the hop limit holds along a chain of hand-offs", () => {
  assert.deepEqual(deliveries({ author: "agent:a1", hops: MAX_HOPS - 1, channelKind: "channel", agents: [docs], mentioned: ["docs"] }), [{ agent_id: "a2", hops: MAX_HOPS }]);
  assert.deepEqual(deliveries({ author: "agent:a1", hops: MAX_HOPS, channelKind: "channel", agents: [docs], mentioned: ["docs"] }), []);
});
