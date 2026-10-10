import assert from "node:assert/strict";
import { test } from "node:test";

import type { User, Viewer } from "@g1t/contracts";

import { liveAddress, offerTicket, openLive, setLiveViaToken, takeOfferedTicket } from "./live-socket.ts";
import { TICKET_PARAM, TICKET_ROUTE, TICKET_SECONDS, issueTicket, openTicket, socketPath, ticketViewer } from "./socket-ticket.ts";
import { tokenVerdict, websiteUser } from "./website-token.ts";

const SECRET = "site-secret";
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

const ada: User = {
  id: "usr_ada",
  username: "ada",
  kind: "user",
  verified: true,
  workspaces: [{ slug: "acme", role: "owner" }],
  token: { token_id: "tok_web", scopes: ["repo:read"], website: true },
};

/** identity's `user_for_access_token` as the site narrows it, over a table that tests change. */
const table: Record<string, Viewer> = {};
const lookup = async (token: string) => websiteUser(table[token] ?? null);

function reset() {
  for (const key of Object.keys(table)) delete table[key];
  table.g1t_web = ada;
}

function upgrade(path: string, ticket: string | null, headers: Record<string, string> = { upgrade: "websocket" }): Request {
  const url = new URL(`https://g1t.sh${path}`);
  if (ticket) url.searchParams.set("ticket", ticket);
  return new Request(url, { headers });
}

const CHAT = "/acme/-/chat/live";

test("only the site's live sockets take a ticket, in the form the routes match", () => {
  assert.deepEqual(socketPath("/-/live"), { path: "/-/live", workspace: null });
  assert.deepEqual(socketPath("/Acme//-/chat/live/"), { path: "/acme/-/chat/live", workspace: "acme" });
  assert.deepEqual(socketPath("/acme/-/artifacts/live"), { path: "/acme/-/artifacts/live", workspace: "acme" });
  for (const path of ["/", "/acme", "/acme/-/chat", "/acme/-/inbox/live", "/-/-/chat/live", "/acme/web/-/chat/live", "/-/live/ticket", "/%E0%A4%A"]) {
    assert.equal(socketPath(path), null, path);
  }
});

test("a ticket opens the socket it was made for, as the token's owner", async () => {
  reset();
  const { ticket, expires_at } = await issueTicket(SECRET, { token: "g1t_web", userId: "usr_ada", path: CHAT }, NOW);
  assert.match(ticket, /^st1\.[A-Za-z0-9_-]+$/);
  assert.equal(expires_at, new Date(NOW + TICKET_SECONDS * 1000).toISOString());
  assert.ok(!ticket.includes("g1t_web"), "the token is not readable in the ticket");
  assert.deepEqual(await openTicket(SECRET, ticket, CHAT, NOW + 1000), { token: "g1t_web", userId: "usr_ada" });
  const viewer = await ticketViewer(upgrade(`${CHAT}?channel=ch_1`, ticket), SECRET, lookup, NOW + 1000);
  assert.equal(viewer?.id, "usr_ada");
  // The path as the browser may spell it.
  assert.equal((await ticketViewer(upgrade("/ACME/-/chat/live/", ticket), SECRET, lookup, NOW))?.id, "usr_ada");
});

test("a ticket past its minute opens nothing", async () => {
  reset();
  const { ticket } = await issueTicket(SECRET, { token: "g1t_web", userId: "usr_ada", path: CHAT }, NOW);
  assert.ok(await openTicket(SECRET, ticket, CHAT, NOW + (TICKET_SECONDS - 1) * 1000));
  assert.equal(await openTicket(SECRET, ticket, CHAT, NOW + TICKET_SECONDS * 1000), null);
  assert.equal(await ticketViewer(upgrade(CHAT, ticket), SECRET, lookup, NOW + 5 * 60_000), null);
});

test("a ticket opens no other socket: another kind, or another workspace's", async () => {
  reset();
  const { ticket } = await issueTicket(SECRET, { token: "g1t_web", userId: "usr_ada", path: CHAT }, NOW);
  for (const path of ["/acme/-/artifacts/live", "/-/live", "/other/-/chat/live"]) {
    assert.equal(await openTicket(SECRET, ticket, path, NOW), null, path);
    assert.equal(await ticketViewer(upgrade(path, ticket), SECRET, lookup, NOW), null, path);
  }
});

test("a ticket changed in any way, or sealed with another key, opens nothing", async () => {
  reset();
  const { ticket } = await issueTicket(SECRET, { token: "g1t_web", userId: "usr_ada", path: CHAT }, NOW);
  const body = ticket.slice(4);
  for (let i = 0; i < body.length; i += 7) {
    const swapped = body[i] === "A" ? "B" : "A";
    const tampered = `st1.${body.slice(0, i)}${swapped}${body.slice(i + 1)}`;
    assert.equal(await openTicket(SECRET, tampered, CHAT, NOW), null, `byte ${i}`);
  }
  for (const bad of ["", "st1.", "st1.!!!", `st2.${body}`, body, `st1.${body}x`, `st1.${"A".repeat(3000)}`]) {
    assert.equal(await openTicket(SECRET, bad, CHAT, NOW), null, bad.slice(0, 20));
  }
  assert.equal(await openTicket("another-secret", ticket, CHAT, NOW), null);
});

test("the token is checked again when the socket opens: deleted, revoked or without the website permission, it opens nothing", async () => {
  reset();
  const { ticket } = await issueTicket(SECRET, { token: "g1t_web", userId: "usr_ada", path: CHAT }, NOW);
  // Deleted, expired or revoked: identity knows it no more.
  delete table.g1t_web;
  assert.equal(await ticketViewer(upgrade(CHAT, ticket), SECRET, lookup, NOW), null);
  // "Use the website as you" turned off since the page loaded.
  table.g1t_web = { ...ada, token: { token_id: "tok_web", scopes: ["repo:read"], website: false } };
  assert.equal(await ticketViewer(upgrade(CHAT, ticket), SECRET, lookup, NOW), null);
  // A token that now names someone else.
  table.g1t_web = { ...ada, id: "usr_bob", username: "bob" };
  assert.equal(await ticketViewer(upgrade(CHAT, ticket), SECRET, lookup, NOW), null);
  // A ticket made for something that is not a token.
  const odd = await issueTicket(SECRET, { token: "a".repeat(64), userId: "usr_ada", path: CHAT }, NOW);
  table["a".repeat(64)] = ada;
  assert.equal(await ticketViewer(upgrade(CHAT, odd.ticket), SECRET, lookup, NOW), null);
});

test("a ticket is never taken by anything but a socket's upgrade", async () => {
  reset();
  const { ticket } = await issueTicket(SECRET, { token: "g1t_web", userId: "usr_ada", path: CHAT }, NOW);
  // The socket's own address, asked without an upgrade.
  assert.equal(await ticketViewer(upgrade(CHAT, ticket, {}), SECRET, lookup, NOW), null);
  assert.equal(await ticketViewer(upgrade(CHAT, ticket, { upgrade: "h2c" }), SECRET, lookup, NOW), null);
  // Pages, data requests and form posts: the token rules see no token, so the session cookie (or no one) decides.
  for (const path of ["/acme", "/acme/-/chat", "/acme/-/chat.data", "/settings/tokens"]) {
    const page = new Request(`https://g1t.sh${path}?ticket=${encodeURIComponent(ticket)}`);
    assert.deepEqual(await tokenVerdict(page, async () => ada), { kind: "none" }, path);
    const post = new Request(`https://g1t.sh${path}?ticket=${encodeURIComponent(ticket)}`, { method: "POST", body: new FormData() });
    assert.deepEqual(await tokenVerdict(post, async () => ada), { kind: "none" }, path);
  }
  // An upgrade without a ticket is the session's business, as before.
  assert.equal(await ticketViewer(upgrade(CHAT, null), SECRET, lookup, NOW), null);
});

test("a session's page opens its sockets at once and adds no ticket; a token's page asks for one first", async () => {
  const site = new URL("https://g1t.sh/acme/-/chat");
  const was = { location: globalThis.location, fetch: globalThis.fetch };
  Object.defineProperty(globalThis, "location", { value: site, configurable: true });
  const asked: string[] = [];
  globalThis.fetch = (async (input: string) => {
    asked.push(String(input));
    return Response.json({ ticket: "st1.abc", expires_at: "2026-10-09T12:01:00.000Z" });
  }) as typeof fetch;
  try {
    assert.equal(liveAddress(CHAT, { channel: "ch_1" }, null), "wss://g1t.sh/acme/-/chat/live?channel=ch_1");

    setLiveViaToken(false);
    const opened: string[] = [];
    openLive(CHAT, () => ({ channel: "ch_1" }), (address) => opened.push(address), () => false);
    assert.deepEqual(opened, ["wss://g1t.sh/acme/-/chat/live?channel=ch_1"], "synchronously, with no ticket");
    assert.deepEqual(asked, []);

    setLiveViaToken(true);
    const viaToken = await new Promise<string>((resolve) => openLive("/-/live", () => ({ workspace: "acme" }), resolve, () => false));
    assert.equal(viaToken, "wss://g1t.sh/-/live?workspace=acme&ticket=st1.abc");
    assert.deepEqual(asked, ["/-/live/ticket?path=%2F-%2Flive"]);
    // The page's copy of the route and parameter, as the server has them.
    assert.equal(TICKET_ROUTE, "/-/live/ticket");
    assert.equal(TICKET_PARAM, "ticket");

    // Closed while the ticket was on its way: nothing opens.
    let late = false;
    openLive(CHAT, () => ({}), () => (late = true), () => true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(late, false);

    // A ticket the page's loader minted opens the first socket with no
    // request; it is used once, and not when its minute is nearly up.
    asked.length = 0;
    offerTicket(CHAT, { ticket: "st1.minted", expires_at: new Date(Date.now() + 50_000).toISOString() });
    const minted: string[] = [];
    openLive(CHAT, () => ({ channel: "ch_2" }), (address) => minted.push(address), () => false);
    assert.deepEqual(minted, ["wss://g1t.sh/acme/-/chat/live?channel=ch_2&ticket=st1.minted"], "synchronously, from the offered ticket");
    assert.deepEqual(asked, []);
    const again = await new Promise<string>((resolve) => openLive(CHAT, () => ({ channel: "ch_2" }), resolve, () => false));
    assert.equal(again, "wss://g1t.sh/acme/-/chat/live?channel=ch_2&ticket=st1.abc", "the next socket asks, as the offer was used");
    assert.deepEqual(asked, [`/-/live/ticket?path=${encodeURIComponent(CHAT)}`]);
    offerTicket(CHAT, { ticket: "st1.stale", expires_at: new Date(Date.now() + 2_000).toISOString() });
    assert.equal(takeOfferedTicket(CHAT), null, "an offer about to expire is not used");
    offerTicket(CHAT, null);
    assert.equal(takeOfferedTicket(CHAT), null);
  } finally {
    setLiveViaToken(false);
    Object.defineProperty(globalThis, "location", { value: was.location, configurable: true });
    globalThis.fetch = was.fetch;
  }
});
