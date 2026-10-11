import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_HOPS, type RecentMessage, addressedAgents, chainFor, deliveries, delivery, handOffPlace, handOffRefusal, personalAgentRefusal, wakeable } from "./delivery.ts";

const ship = { id: "a1", handle: "ship" };
const docs = { id: "a2", handle: "docs" };

test("a person's direct message with nothing said yet wakes every agent in it, at hop 0", () => {
  assert.deepEqual(deliveries({ author: "user:u", hops: 3, channelKind: "dm", agents: [ship, docs], mentioned: [] }), [
    { agent_id: "a1", hops: 0 },
    { agent_id: "a2", hops: 0 },
  ]);
  assert.deepEqual(deliveries({ author: "user:u", hops: 0, channelKind: "dm", agents: [ship, docs], mentioned: [], recent: [] }), [
    { agent_id: "a1", hops: 0 },
    { agent_id: "a2", hops: 0 },
  ]);
  // With one agent there is nobody else it could be for.
  assert.deepEqual(deliveries({ author: "user:u", hops: 0, channelKind: "dm", agents: [ship], mentioned: [], recent: [{ author: "user:u", mentioned: ["docs"] }] }), [{ agent_id: "a1", hops: 0 }]);
});

const mike = { id: "a_mike", handle: "mike" };
const g1t = { id: "a_g1t", handle: "g1t" };
const says = (author: string, ...mentioned: string[]): RecentMessage => ({ author, mentioned });

test("in a group DM, an unaddressed message goes to the agent the person is talking with", () => {
  // The conversation as it happened: Chase, Mike the recruiter and @g1t in one group message.
  const transcript = [
    says("user:chase"), // "Are you able to generate PDFs now?"
    says("agent:a_mike"),
    says("agent:a_g1t"),
    says("user:chase", "mike"), // "@Mike Make a PDF of that example resume for me"
    says("agent:a_mike"),
  ];
  // "Let's take that template and make a fake resume for some fake person": Mike was helping.
  assert.deepEqual(deliveries({ author: "user:chase", hops: 0, channelKind: "dm", agents: [mike, g1t], mentioned: [], recent: transcript }), [{ agent_id: "a_mike", hops: 0 }]);
  // The first question, with nothing before it, went to both; so does a follow-up to both their answers.
  assert.deepEqual(addressedAgents([mike, g1t], "user:chase", []), [mike, g1t]);
  assert.deepEqual(addressedAgents([mike, g1t], "user:chase", transcript.slice(0, 3)), [mike, g1t]);
  // A mention still goes only to those named, whoever was talking.
  assert.deepEqual(deliveries({ author: "user:chase", hops: 0, channelKind: "dm", agents: [mike, g1t], mentioned: ["g1t"], recent: transcript }), [{ agent_id: "a_g1t", hops: 0 }]);
});

test("who is addressed: the last exchange, else the person's last mention, else everyone", () => {
  // Mentioned but not yet answered: the mention stands, through the person's own follow-ups.
  assert.deepEqual(addressedAgents([mike, g1t], "user:chase", [says("user:chase", "Mike"), says("user:chase")]), [mike]);
  // Answered by a colleague after the mention (a hand-off here, say): the colleague has the conversation now.
  assert.deepEqual(addressedAgents([mike, g1t], "user:chase", [says("user:chase", "mike"), says("agent:a_mike", "g1t"), says("user:chase"), says("agent:a_g1t")]), [g1t]);
  // Both answered the last message: both are in the exchange, in the conversation's order.
  assert.deepEqual(addressedAgents([mike, g1t], "user:chase", [says("user:chase", "g1t", "mike"), says("agent:a_g1t"), says("agent:a_mike")]), [mike, g1t]);
  // A thank-you in between changes nothing: the person's last mention still says who.
  assert.deepEqual(addressedAgents([mike, g1t], "user:chase", [says("user:chase", "mike"), says("agent:a_mike"), says("user:chase"), says("user:chase")]), [mike]);
  // Another person's message ends the exchange without deciding it; only this person's mentions do.
  assert.deepEqual(addressedAgents([mike, g1t], "user:chase", [says("user:chase", "mike"), says("agent:a_mike"), says("user:bo", "g1t")]), [mike]);
  assert.deepEqual(addressedAgents([mike, g1t], "user:chase", [says("user:bo", "g1t"), says("agent:a_g1t")]), [g1t], "whoever answered last, whoever they answered");
  // A second message before anyone answers the first goes where the first did.
  assert.deepEqual(addressedAgents([mike, g1t], "user:chase", [says("user:bo", "g1t"), says("agent:a_g1t"), says("user:chase")]), [g1t]);
  assert.deepEqual(addressedAgents([mike, g1t], "user:chase", [says("user:chase"), says("agent:a_mike"), says("user:chase")]), [mike], "only Mike answered the first");
  // Mentions of agents that aren't here, and messages of agents that left, decide nothing.
  assert.deepEqual(addressedAgents([mike, g1t], "user:chase", [says("user:chase", "sam"), says("agent:a_gone")]), [mike, g1t]);
  assert.deepEqual(addressedAgents([mike], "user:chase", [says("user:chase", "g1t")]), [mike], "one agent: nothing to decide");
});

test("in a group direct message, a person who mentions some of its agents wakes only those", () => {
  assert.deepEqual(deliveries({ author: "user:u", hops: 0, channelKind: "dm", agents: [ship, docs], mentioned: ["docs"] }), [{ agent_id: "a2", hops: 0 }]);
  // Mentioning someone who isn't in it is no mention of its agents: all of them answer.
  assert.deepEqual(deliveries({ author: "user:u", hops: 0, channelKind: "dm", agents: [ship, docs], mentioned: ["mike"] }), [
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

test("an agent's message wakes nobody, even when it @mentions an agent member", () => {
  assert.deepEqual(deliveries({ author: "agent:a1", hops: 0, channelKind: "dm", agents: [ship, docs], mentioned: [] }), []);
  assert.deepEqual(deliveries({ author: "agent:a1", hops: 0, channelKind: "dm", agents: [ship, docs], mentioned: ["docs"] }), []);
  assert.deepEqual(deliveries({ author: "agent:a1", hops: 2, channelKind: "channel", agents: [ship, docs], mentioned: ["docs", "ship"] }), []);
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

test("a chain is the agents that handled a request, with the poster added", () => {
  assert.deepEqual(chainFor(["a9"], "a1"), ["a9", "a1"]);
  assert.deepEqual(chainFor("nonsense", "a1"), ["a1"]);
});

test("a hand-off goes here when the colleague is in this channel or group DM, else to a group DM", () => {
  assert.equal(handOffPlace({ channelKind: "channel", members: 40, colleagueHere: true }), "here");
  assert.equal(handOffPlace({ channelKind: "dm", members: 3, colleagueHere: true }), "here");
  assert.equal(handOffPlace({ channelKind: "channel", members: 40, colleagueHere: false }), "group_dm");
  // The 1:1 DM the user saw: @g1t and the person, Mike not in it.
  assert.equal(handOffPlace({ channelKind: "dm", members: 2, colleagueHere: false }), "group_dm");
});

test("a hand-off is refused to itself, to @g1t, back along the chain, and past the hop limit", () => {
  const ok = { agent: "a9", colleague: { id: "a1" }, chain: [], hops: 0 };
  assert.equal(handOffRefusal(ok), null);
  assert.match(handOffRefusal({ ...ok, colleague: { id: "a9" } })!, /itself/);
  assert.match(handOffRefusal({ ...ok, agent: "a1", colleague: { id: "a9", builtin: true } })!, /@g1t/);
  assert.match(handOffRefusal({ ...ok, agent: "a2", chain: ["a1", "a2"] })!, /already handled/);
  assert.equal(handOffRefusal({ ...ok, hops: MAX_HOPS - 1 }), null);
  assert.match(handOffRefusal({ ...ok, hops: MAX_HOPS })!, /too many times/);
});

test("a personal agent is only in the direct message of it and the person it belongs to", () => {
  const mine = { id: "a9", handle: "pip", scope: "personal", personal_owner_id: "u1" };
  assert.equal(personalAgentRefusal(mine, { kind: "dm", members: ["user:u1", "agent:a9"] }), null);
  assert.match(personalAgentRefusal(mine, { kind: "dm", members: ["user:u2", "agent:a9"] }) ?? "", /personal agent/);
  assert.match(personalAgentRefusal(mine, { kind: "dm", members: ["user:u1", "user:u2", "agent:a9"] }) ?? "", /personal agent/, "not a group DM");
  assert.match(personalAgentRefusal(mine, { kind: "channel", members: null }) ?? "", /personal agent/, "never invited to a channel");
  assert.match(personalAgentRefusal(mine, { kind: "hand_off", members: null }) ?? "", /personal agent/, "never handed work");
  assert.equal(personalAgentRefusal({ id: "a1", handle: "ship", scope: "workspace" }, { kind: "channel", members: null }), null);
  assert.equal(personalAgentRefusal({ id: "a1", handle: "ship" }, { kind: "hand_off", members: null }), null, "agents from before personal ones are the workspace's");
});

test("an archived agent stays a member but is never woken; one the agents service no longer knows, or of another workspace, neither", () => {
  const live = { id: "a1", handle: "ship", workspace_id: "wsp_1", archived_at: null };
  const archived = { id: "a2", handle: "docs", workspace_id: "wsp_1", archived_at: "2026-10-09T10:00:00Z" };
  const elsewhere = { id: "a3", handle: "ops", workspace_id: "wsp_2", archived_at: null };
  const found = new Map<string, typeof live | null>([
    ["a1", live],
    ["a2", archived],
    ["a3", elsewhere],
    // Deleted for good: chat still has its membership row, the agents service has nothing.
    ["a4", null],
  ]);
  assert.deepEqual(wakeable(found.values(), "wsp_1"), [live]);
  // In a direct message with the two of them, an unaddressed message goes to the live one alone.
  const agents = wakeable(found.values(), "wsp_1").map((a) => ({ id: a.id, handle: a.handle }));
  assert.deepEqual(deliveries({ author: "user:u", hops: 0, channelKind: "dm", agents, mentioned: [] }), [{ agent_id: "a1", hops: 0 }]);
  // Mentioning the archived one by handle wakes nobody: it is not among the wakeable.
  assert.deepEqual(deliveries({ author: "user:u", hops: 0, channelKind: "channel", agents, mentioned: ["docs"] }), []);
  assert.deepEqual(wakeable([], "wsp_1"), []);
});
