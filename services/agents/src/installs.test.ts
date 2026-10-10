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
  assert.deepEqual(findListing("agent:engineering"), { ref: "agent:engineering", kind: "agent", id: "engineering", name: "Software Engineer" });
  assert.equal(findListing("integration:sentry")?.name, "Sentry");
  assert.equal(findListing("agent:astronaut"), null, "no such role");
  assert.equal(findListing("integration:slack"), null, "Slack is planned, not available");
  assert.equal(findListing("integration:mcp"), null, "MCP clients are connected by each person, not a workspace");
  assert.equal(findListing("extension:support"), null, "no extensions are listed yet");
  assert.equal(findListing(42), null);
});

test("references parse strictly, and notes are tidied", () => {
  assert.deepEqual(parseListing(" integration:alerts-webhook "), { kind: "integration", id: "alerts-webhook" });
  assert.equal(parseListing("agent:"), null);
  assert.equal(parseListing("agent:Engineering"), null);
  assert.equal(parseListing("agent:a b"), null);
  assert.equal(cleanRequestNote("  for   on-call  "), "for on-call");
  assert.equal(cleanRequestNote("   "), null);
  assert.equal(cleanRequestNote("x".repeat(400))?.length, 280);
  assert.equal(cleanRequestNote(null), null);
});

test("a member's request is kept, and asking twice is one request", async () => {
  const db = fakeD1();
  const listing = findListing("agent:qa")!;
  const first = await openRequest(db, ws, nextId(), listing, ana, "Flaky checks", at);
  assert.ok(first.ok);
  assert.equal(first.value.status, "open");
  assert.equal(first.value.name, "QA Engineer");
  assert.equal(first.value.note, "Flaky checks");
  const again = await openRequest(db, ws, nextId(), listing, ana, null, later(0.1));
  assert.equal(again.ok, false);
  assert.equal(!again.ok && again.error.code, "conflict");
  // Someone else asking for the same thing is their own request.
  assert.ok((await openRequest(db, ws, nextId(), listing, bo, null, at)).ok);
});

test("an owner sees every request; a member sees their own", async () => {
  const db = fakeD1();
  await openRequest(db, ws, nextId(), findListing("agent:qa")!, ana, null, at);
  await openRequest(db, ws, nextId(), findListing("integration:linear")!, bo, null, later(0.01));
  await openRequest(db, "wsp_other", nextId(), findListing("agent:docs")!, ana, null, at);
  assert.deepEqual((await listRequests(db, ws, owner, true, at)).map((r) => r.listing), ["integration:linear", "agent:qa"]);
  assert.deepEqual((await listRequests(db, ws, ana, false, at)).map((r) => r.listing), ["agent:qa"]);
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
  await openRequest(db, ws, nextId(), findListing("agent:support")!, ana, null, at);
  await openRequest(db, ws, nextId(), findListing("agent:support")!, bo, null, at);
  await openRequest(db, ws, nextId(), findListing("agent:sales")!, bo, null, at);
  const answered = await resolveListing(db, ws, "agent:support", owner, later(1));
  assert.deepEqual(answered.map((a) => a.requested_by_id).sort(), ["usr_ana", "usr_bo"]);
  assert.ok(answered.every((a) => a.request.status === "done"));
  const open = (await listRequests(db, ws, owner, true, later(1))).filter((r) => r.status === "open");
  assert.deepEqual(open.map((r) => r.listing), ["agent:sales"]);
});

test("a person keeps at most so many requests open", async () => {
  const db = fakeD1();
  // The catalog has fewer listings than the limit, so the same few are asked, answered and asked again.
  const listings = ["agent:engineering", "agent:qa", "agent:operations", "agent:docs", "agent:product", "agent:support", "agent:sales", "integration:sentry", "integration:datadog", "integration:linear", "integration:jira", "integration:github", "integration:webhooks", "integration:alerts-webhook", "integration:anthropic", "integration:openai", "integration:gemini", "integration:xai", "integration:mistral", "integration:deepseek"];
  assert.equal(listings.length, MAX_OPEN_REQUESTS);
  for (const ref of listings) assert.ok((await openRequest(db, ws, nextId(), findListing(ref)!, ana, null, at)).ok, ref);
  const over = await openRequest(db, ws, nextId(), findListing("integration:groq")!, ana, null, at);
  assert.equal(!over.ok && over.error.code, "limit");
});

test("what the asker is told, and where it leads", () => {
  const base = { id: "ins_1", listing: "agent:qa", kind: "agent" as const, name: "QA Engineer", note: null, requested_by: "ana", requested_at: at.toISOString(), resolved_by: "chase", resolved_at: at.toISOString() };
  assert.equal(answerLine({ ...base, status: "done" }, "@chase").title, "QA Engineer was added to the workspace");
  assert.match(answerLine({ ...base, status: "declined" }, "@chase").title, /@chase turned down your request for QA Engineer/);
  assert.equal(listingPath("acme", "agent:qa"), "/acme/-/marketplace/agents/qa");
  assert.equal(listingPath("acme", "integration:sentry"), "/acme/-/marketplace/integrations");
});
