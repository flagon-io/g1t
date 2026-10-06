import assert from "node:assert/strict";
import { test } from "node:test";

import { alertLetter, bindingSender, confirmLetter, memorySender, render, unsubscribeHeaders, updateLetter } from "./email.ts";
import { atom, feedItems, jsonFeed } from "./feed.ts";
import { chosenParts, hashToken, newToken, normalizeEmail, parseParts, readUnsubscribeToken, unsubscribeToken, wants } from "./subscribers.ts";

test("addresses are trimmed, lowercased and checked", () => {
  assert.equal(normalizeEmail("  Ana@Example.COM "), "ana@example.com");
  assert.equal(normalizeEmail("nope"), null);
  assert.equal(normalizeEmail("a@b"), null);
  assert.equal(normalizeEmail("a b@example.com"), null);
  assert.equal(normalizeEmail(42), null);
});

test("confirmation tokens: random, and only their hash is kept", async () => {
  const a = newToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(newToken(), a);
  const hash = await hashToken(a);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(await hashToken(a), hash, "the same token hashes the same");
  assert.ok(!hash.includes(a));
});

test("unsubscribe links are signed, not stored, and refuse tampering", async () => {
  const token = await unsubscribeToken("secret", "sub-1");
  assert.ok(token.startsWith("sub-1."));
  assert.equal(await readUnsubscribeToken("secret", token), "sub-1");
  assert.equal(await readUnsubscribeToken("other", token), null, "another secret");
  assert.equal(await readUnsubscribeToken("secret", token.replace("sub-1", "sub-2")), null, "another subscriber");
  assert.equal(await readUnsubscribeToken("secret", `${token}x`), null);
  assert.equal(await readUnsubscribeToken("secret", "garbage"), null);
});

test("per-part subscriptions", () => {
  assert.equal(chosenParts([], ["git", "api"]), null, "none chosen is everything");
  assert.equal(chosenParts(["git", "api"], ["git", "api"]), null, "all chosen is everything");
  assert.deepEqual(chosenParts(["git", "git", "zzz"], ["git", "api"]), ["git"]);
  assert.equal(parseParts(null), null);
  assert.deepEqual(parseParts('["git"]'), ["git"]);
  assert.equal(parseParts("not json"), null);
  assert.equal(wants(null, ["api"]), true);
  assert.equal(wants(["git"], ["api"]), false);
  assert.equal(wants(["git"], ["api", "git"]), true);
  assert.equal(wants(["git"], []), true, "news about no part in particular goes to everyone");
});

test("letters: escaped HTML, plain text, and an unsubscribe link in every update", () => {
  const { text, html } = render(updateLetter({ heading: "Identified: <Pushes>", text: "A bad deploy.", url: "https://status.g1t.sh/incidents/a", affects: ["Git"], unsubscribe: "https://status.g1t.sh/unsubscribe?token=x" }));
  assert.ok(html.includes("Identified: &lt;Pushes&gt;") && !html.includes("<Pushes>"));
  assert.ok(text.includes("Unsubscribe: https://status.g1t.sh/unsubscribe?token=x"));
  assert.ok(text.includes("Affects: Git."));
  assert.equal(unsubscribeHeaders("https://u")["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.ok(render(confirmLetter("https://c", ["Git"])).text.includes("affecting Git"));
  assert.ok(render(alertLetter({ title: "Detected: API not answering", parts: ["API"], since: "5 Oct 12:00 UTC", link: "https://sudo.g1t.sh/incidents/x" })).text.includes("https://sudo.g1t.sh/incidents/x"));
});

test("senders: the binding when there is one, none otherwise", async () => {
  assert.equal(bindingSender(undefined), null);
  const calls: unknown[] = [];
  const sender = bindingSender({ send: async (m) => void calls.push(m) }, "Status <s@g1t.sh>");
  await sender!.send({ to: "a@b.co", subject: "Hi", text: "t", html: "h" });
  assert.deepEqual(calls, [{ to: "a@b.co", from: "Status <s@g1t.sh>", subject: "Hi", text: "t", html: "h" }]);
  const memory = memorySender();
  await memory.send({ to: "a@b.co", subject: "Hi", text: "t", html: "h" });
  assert.equal(memory.sent.length, 1);
});

test("feeds: every public update and maintenance notice, newest first, in Atom and JSON Feed", () => {
  const incidents = [
    {
      id: "a",
      title: "Pushes & pulls failing",
      impact: "down" as const,
      status: "resolved" as const,
      components: ["git"],
      component_impacts: [{ key: "git", impact: "major_outage" as const }],
      started_at: "2026-10-05T11:00:00Z",
      resolved_at: "2026-10-05T12:00:00Z",
      url: "https://status.g1t.sh/incidents/a",
      postmortem_published_at: null,
      updates: [
        { id: "u2", at: "2026-10-05T12:00:00Z", status: "resolved" as const, text: "Fixed." },
        { id: "u1", at: "2026-10-05T11:05:00Z", status: "investigating" as const, text: "Looking <now>." },
      ],
    },
  ];
  const maintenance = [
    { id: "m", title: "Upgrade", message: "m", components: ["git"], starts_at: "2026-10-06T02:00:00Z", ends_at: "2026-10-06T03:00:00Z", state: "scheduled" as const, url: "https://status.g1t.sh/maintenance/m", updates: [{ id: "mu", at: "2026-10-05T11:30:00Z", text: "Scheduled." }] },
  ];
  const items = feedItems(incidents, maintenance);
  assert.deepEqual(items.map((i) => i.title), ["Resolved: Pushes & pulls failing", "Maintenance: Upgrade", "Investigating: Pushes & pulls failing"]);
  assert.equal(items[0]!.url, "https://status.g1t.sh/incidents/a#update-u2");
  const xml = atom(items, { origin: "https://status.g1t.sh", title: "g1t status", updated: "2026-10-05T13:00:00Z" });
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">'));
  assert.ok(xml.includes("<title>Resolved: Pushes &amp; pulls failing</title>"));
  assert.ok(xml.includes("Looking &lt;now&gt;."));
  assert.ok(xml.includes("<updated>2026-10-05T12:00:00Z</updated>"));
  assert.equal((xml.match(/<entry>/g) ?? []).length, 3);
  const json = jsonFeed(items, { origin: "https://status.g1t.sh", title: "g1t status", updated: "" }) as { version: string; items: { id: string; content_text: string }[] };
  assert.equal(json.version, "https://jsonfeed.org/version/1.1");
  assert.equal(json.items[2]!.content_text, "Looking <now>.");
  assert.equal(feedItems(incidents, maintenance, 1).length, 1);
});
