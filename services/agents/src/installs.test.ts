import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { MAX_OPEN_REQUESTS, cleanRequestNote, parseListing } from "@g1t/contracts/marketplace";

import { answerLine, findListing, listRequests, listingPath, openRequest, resolveListing, resolveRequest } from "./installs.ts";

/** D1, as far as install requests use it, over node's SQLite with the service's migrations. */
function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => (db.prepare(sql).get(...(params as never[])) as unknown) ?? null,
    run: async () => db.prepare(sql).run(...(params as never[])),
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

let ids = 0;
const nextId = () => `ins_${++ids}`;
const ws = "wsp_acme";
const ana = { id: "usr_ana", username: "ana" };
const bo = { id: "usr_bo", username: "bo" };
const owner = { id: "usr_own", username: "chase" };
const at = new Date("2026-10-10T12:00:00.000Z");
const later = (days: number) => new Date(at.getTime() + days * 86_400_000);

test("only what a workspace can add today is a listing", () => {
  assert.deepEqual(findListing("integration:sentry"), { ref: "integration:sentry", kind: "integration", id: "sentry", name: "Sentry" });
  assert.equal(findListing("agent:engineering"), null, "agents start from templates in Agents, not the Marketplace");
  assert.equal(findListing("integration:astronaut"), null, "no such integration");
  assert.equal(findListing("integration:slack"), null, "Slack is planned, not available");
  assert.equal(findListing("integration:mcp"), null, "MCP clients are connected by each person, not a workspace");
  assert.equal(findListing("extension:support"), null, "no extensions are listed yet");
  assert.equal(findListing(42), null);
});

test("references parse strictly, and notes are tidied", () => {
  assert.deepEqual(parseListing(" integration:alerts-webhook "), { kind: "integration", id: "alerts-webhook" });
  assert.equal(parseListing("integration:"), null);
  assert.equal(parseListing("integration:Sentry"), null);
  assert.equal(parseListing("integration:a b"), null);
  assert.equal(parseListing("agent:qa"), null);
  assert.equal(cleanRequestNote("  for   on-call  "), "for on-call");
  assert.equal(cleanRequestNote("   "), null);
  assert.equal(cleanRequestNote("x".repeat(400))?.length, 280);
  assert.equal(cleanRequestNote(null), null);
});

test("a member's request is kept, and asking twice is one request", async () => {
  const db = fakeD1();
  const listing = findListing("integration:sentry")!;
  const first = await openRequest(db, ws, nextId(), listing, ana, "Flaky checks", at);
  assert.ok(first.ok);
  assert.equal(first.value.status, "open");
  assert.equal(first.value.name, "Sentry");
  assert.equal(first.value.kind, "integration");
  assert.equal(first.value.note, "Flaky checks");
  const again = await openRequest(db, ws, nextId(), listing, ana, null, later(0.1));
  assert.equal(again.ok, false);
  assert.equal(!again.ok && again.error.code, "conflict");
  // Someone else asking for the same thing is their own request.
  assert.ok((await openRequest(db, ws, nextId(), listing, bo, null, at)).ok);
});

test("an owner sees every request; a member sees their own", async () => {
  const db = fakeD1();
  await openRequest(db, ws, nextId(), findListing("integration:jira")!, ana, null, at);
  await openRequest(db, ws, nextId(), findListing("integration:linear")!, bo, null, later(0.01));
  await openRequest(db, "wsp_other", nextId(), findListing("integration:datadog")!, ana, null, at);
  assert.deepEqual((await listRequests(db, ws, owner, true, at)).map((r) => r.listing), ["integration:linear", "integration:jira"]);
  assert.deepEqual((await listRequests(db, ws, ana, false, at)).map((r) => r.listing), ["integration:jira"]);
});

test("answering a request: once, by status, and answered ones age out", async () => {
  const db = fakeD1();
  const opened = await openRequest(db, ws, nextId(), findListing("integration:sentry")!, ana, null, at);
  assert.ok(opened.ok);
  const answered = await resolveRequest(db, ws, opened.value.id, "declined", owner, later(1));
  assert.ok(answered.ok);
  assert.equal(answered.value.request.status, "declined");
  assert.equal(answered.value.request.resolved_by, "chase");
  assert.equal(answered.value.requested_by_id, "usr_ana");
  const twice = await resolveRequest(db, ws, opened.value.id, "done", owner, later(1));
  assert.equal(!twice.ok && twice.error.code, "conflict");
  const elsewhere = await resolveRequest(db, "wsp_other", opened.value.id, "done", owner, later(1));
  assert.equal(!elsewhere.ok && elsewhere.error.code, "not_found");
  // Turned down, the person may ask again.
  assert.ok((await openRequest(db, ws, nextId(), findListing("integration:sentry")!, ana, null, later(2))).ok);
  // Answered requests stay listed for 30 days.
  assert.equal((await listRequests(db, ws, owner, true, later(20))).length, 2);
  assert.equal((await listRequests(db, ws, owner, true, later(40))).length, 1, "only the open one");
});

test("adding a listing answers every open request for it", async () => {
  const db = fakeD1();
  await openRequest(db, ws, nextId(), findListing("integration:linear")!, ana, null, at);
  await openRequest(db, ws, nextId(), findListing("integration:linear")!, bo, null, at);
  await openRequest(db, ws, nextId(), findListing("integration:jira")!, bo, null, at);
  const answered = await resolveListing(db, ws, "integration:linear", owner, later(1));
  assert.deepEqual(answered.map((a) => a.requested_by_id).sort(), ["usr_ana", "usr_bo"]);
  assert.ok(answered.every((a) => a.request.status === "done"));
  const open = (await listRequests(db, ws, owner, true, later(1))).filter((r) => r.status === "open");
  assert.deepEqual(open.map((r) => r.listing), ["integration:jira"]);
});

test("a request kept from a kind the Marketplace no longer lists is left out", async () => {
  const db = fakeD1();
  await openRequest(db, ws, nextId(), findListing("integration:sentry")!, ana, null, at);
  // An agent request, as the table could hold one from before agents left the Marketplace.
  await db
    .prepare("INSERT INTO install_requests (id, workspace_id, listing, name, requested_by, requested_by_id, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind("ins_old", ws, "agent:qa", "QA Engineer", "ana", "usr_ana", at.toISOString())
    .run();
  assert.deepEqual((await listRequests(db, ws, owner, true, at)).map((r) => r.listing), ["integration:sentry"]);
  assert.deepEqual(await resolveListing(db, ws, "agent:qa", owner, later(1)), []);
});

test("a person keeps at most so many requests open", async () => {
  const db = fakeD1();
  const listings = ["integration:github", "integration:webhooks", "integration:linear", "integration:jira", "integration:sentry", "integration:datadog", "integration:alerts-webhook", "integration:anthropic", "integration:openai", "integration:gemini", "integration:xai", "integration:mistral", "integration:deepseek", "integration:azure-openai", "integration:openrouter", "integration:together", "integration:fireworks", "integration:cerebras", "integration:anthropic-endpoint", "integration:openai-endpoint"];
  assert.equal(listings.length, MAX_OPEN_REQUESTS);
  for (const ref of listings) assert.ok((await openRequest(db, ws, nextId(), findListing(ref)!, ana, null, at)).ok, ref);
  const over = await openRequest(db, ws, nextId(), findListing("integration:groq")!, ana, null, at);
  assert.equal(!over.ok && over.error.code, "limit");
});

test("what the asker is told, and where it leads", () => {
  const base = { id: "ins_1", listing: "integration:sentry", kind: "integration" as const, name: "Sentry", note: null, requested_by: "ana", requested_at: at.toISOString(), resolved_by: "chase", resolved_at: at.toISOString() };
  assert.equal(answerLine({ ...base, status: "done" }, "@chase").title, "Sentry was added to the workspace");
  assert.equal(answerLine({ ...base, status: "done" }, "@chase").body, "@chase connected it.");
  assert.match(answerLine({ ...base, status: "declined" }, "@chase").title, /@chase turned down your request for Sentry/);
  assert.equal(listingPath("acme", "extension:support"), "/acme/-/marketplace/extensions/support");
  assert.equal(listingPath("acme", "integration:sentry"), "/acme/-/marketplace/integrations");
});
