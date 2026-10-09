import assert from "node:assert/strict";
import { test } from "node:test";

import { type Colleague, type HandOffPorts, addressed, handOffPort } from "./handoff.ts";
import type { HandedOff } from "./surface.ts";

const mike: Colleague = { id: "agt_mike", handle: "mike", display_name: "Mike", builtin: false, status: "idle" };
const g1t: Colleague = { id: "agt_g1t", handle: "g1t", display_name: "g1t", builtin: true, status: "idle" };
const margo: Colleague = { id: "agt_margo", handle: "margo", display_name: "Margo", builtin: false, status: "paused" };
const sam: Colleague = { id: "agt_sam", handle: "sam", display_name: "Sam", builtin: false, status: "out_of_budget" };

/** A small workspace: these agents, and the person syntaqx. */
function world(over: Partial<HandOffPorts> = {}, answer: HandedOff = { ok: true, where: "group_dm", opened: true }) {
  const handed: { colleague: string; brief: string }[] = [];
  const agents = [mike, g1t, margo, sam];
  const ports: HandOffPorts = {
    self: { id: "agt_g1t", handle: "g1t" },
    chain: [],
    asker: { username: "syntaqx", role: "owner", can_write: true },
    agent: async (handle) => agents.find((a) => a.handle === handle) ?? null,
    person: async (handle) => handle === "syntaqx",
    handOff: async (colleague, brief) => {
      handed.push({ colleague, brief });
      return answer;
    },
    ...over,
  };
  return { port: handOffPort(ports), handed };
}

test("g1t hands Mike the hiring work: he is woken with the brief addressed to him, and g1t is told where it went", async () => {
  const { port, handed } = world();
  const done = await port("mike", "Help Chase hire an engineering manager: draft the role brief.");
  assert.equal(done.ok, true);
  assert.deepEqual(handed, [{ colleague: "agt_mike", brief: "@mike Help Chase hire an engineering manager: draft the role brief." }]);
  assert.match(done.message, /Handed to @mike in a new group message with @syntaqx, you and them/);
  assert.match(done.message, /a card here links to it/);
});

test("handed here, or into the group message they already share", async () => {
  const here = await world({}, { ok: true, where: "here", opened: false }).port("mike", "x");
  assert.match(here.message, /your brief is posted in this conversation/);
  const again = await world({}, { ok: true, where: "group_dm", opened: false }).port("mike", "x");
  assert.match(again.message, /the group message you three already have/);
});

test("refusals: unknown, a person, itself, @g1t, back along the chain, unavailable, an outside asker", async () => {
  const refused = async (handle: string, over: Partial<HandOffPorts> = {}) => {
    const { port, handed } = world(over);
    const done = await port(handle, "Do it.");
    assert.equal(done.ok, false, handle);
    assert.equal(handed.length, 0, `nothing handed to ${handle}`);
    return done.message;
  };
  assert.match(await refused("nobody"), /no agent called @nobody/);
  assert.match(await refused("syntaqx"), /@syntaqx is a person, not an agent/);
  assert.match(await refused("mike", { self: { id: "agt_mike", handle: "mike" } }), /That's you/);
  assert.match(await refused("g1t", { self: { id: "agt_mike", handle: "mike" } }), /@g1t can't be handed work by an agent/);
  assert.match(await refused("mike", { self: { id: "agt_sam", handle: "sam" }, chain: ["agt_g1t", "agt_mike"] }), /already handled this request/);
  assert.match(await refused("margo"), /is paused/);
  assert.match(await refused("sam"), /out of budget/);
  assert.match(await refused("mike", { asker: { username: "eve", role: "outside", can_write: false } }), /isn't a member of this workspace/);
});

test("chat's own refusal comes back to the agent as the tool's answer", async () => {
  const { port } = world({}, { ok: false, message: "This request has been passed along too many times." });
  const done = await port("mike", "x");
  assert.equal(done.ok, false);
  assert.match(done.message, /couldn't be handed over: This request has been passed along too many times/);
});

test("a brief that already names the colleague isn't addressed twice", () => {
  assert.equal(addressed("mike", "@Mike, please draft it."), "@Mike, please draft it.");
  assert.equal(addressed("mike", "Please draft it, cc @mikey."), "@mike Please draft it, cc @mikey.");
});
