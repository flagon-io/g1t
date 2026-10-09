import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanTitle, defaultWhere, threadLink, whereWords, writableSpaces, writeUpAgents, writeUpMessage } from "./write-up.ts";

test("a thread's link is its conversation with ?thread=", () => {
  assert.equal(threadLink("https://g1t.sh/", "/acme/-/chat/launch", "msg_1"), "https://g1t.sh/acme/-/chat/launch?thread=msg_1");
  assert.equal(threadLink("https://g1t.sh", "/acme/-/chat/dm/chn_1", "a b"), "https://g1t.sh/acme/-/chat/dm/chn_1?thread=a%20b");
});

const spaces = writableSpaces([
  { id: "s1", name: "Design", viewer_role: "edit", archived_at: null },
  { id: "s2", name: "Board", viewer_role: "view", archived_at: null },
  { id: "s3", name: "Old", viewer_role: "manage", archived_at: "2026-01-01T00:00:00Z" },
  { id: "s4", name: "General", viewer_role: "manage", archived_at: null, is_default: true },
  { id: "s5", name: "Notes", viewer_role: "comment", archived_at: null },
]);

test("only spaces the person can add to, not archived, General first", () => {
  assert.deepEqual(spaces, [
    { id: "s4", name: "General", is_default: true },
    { id: "s1", name: "Design", is_default: false },
  ]);
});

test("it goes to the conversation in a DM or private channel; to General, else Private, in a public one", () => {
  assert.deepEqual(defaultWhere(true, spaces), { kind: "conversation" });
  assert.deepEqual(defaultWhere(false, spaces), { kind: "space", id: "s4", name: "General" });
  assert.deepEqual(defaultWhere(false, spaces.filter((s) => !s.is_default)), { kind: "private" });
});

test("@g1t is always offered first, then the conversation's agents, once each", () => {
  const agents = writeUpAgents([
    { kind: "user", name: "ana", display_name: "Ana" },
    { kind: "agent", name: "Scribe", display_name: "Scribe" },
    { kind: "agent", name: "g1t", display_name: "g1t" },
    { kind: "agent", name: "scribe", display_name: "Scribe" },
    { kind: "agent", name: "qa", display_name: " " },
  ]);
  assert.deepEqual(agents, [
    { handle: "g1t", name: "g1t" },
    { handle: "scribe", name: "Scribe" },
    { handle: "qa", name: "qa" },
  ]);
});

test("a title is one line without double quotes", () => {
  assert.equal(cleanTitle('  The "launch"\n plan '), "The 'launch' plan");
  assert.equal(cleanTitle(null), "");
  assert.equal(cleanTitle("x".repeat(200)).length, 120);
});

test("the ask names the agent, the kind, where it goes, the title if any, and the thread to cite", () => {
  const link = "https://g1t.sh/acme/-/chat/launch?thread=msg_1";
  assert.equal(
    writeUpMessage({ agent: "g1t", where: { kind: "space", id: "s1", name: "Engineering" }, title: "Launch plan", link }),
    `@g1t write this thread up as an artifact (a doc) in the Engineering space titled "Launch plan". Link this thread as the source: ${link}`,
  );
  assert.equal(writeUpMessage({ agent: "@Scribe", where: { kind: "private" }, title: "  ", link }), `@scribe write this thread up as an artifact (a doc) privately (just for me). Link this thread as the source: ${link}`);
  assert.equal(whereWords({ kind: "conversation" }), "shared with this conversation");
  assert.equal(whereWords({ kind: "space", id: "s", name: " Product  notes " }), "in the Product notes space");
});
