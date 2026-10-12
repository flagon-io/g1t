import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import * as connectors from "./connectors.ts";
import type { Fetch } from "./mcp-client.ts";

function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => (db.prepare(sql).get(...(params as never[])) as unknown) ?? null,
    run: async () => {
      const r = db.prepare(sql).run(...(params as never[]));
      return { meta: { changes: Number(r.changes) } };
    },
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
  });
  const batch = async (statements: { run: () => Promise<unknown> }[]) => Promise.all(statements.map((s) => s.run()));
  return { prepare: (sql: string) => statement(sql), batch } as unknown as D1Database;
}

const KEY = "ab".repeat(32);
const ws = "wsp_acme";
const at = new Date("2026-10-11T12:00:00.000Z");

/** An MCP server with an OAuth authorization server beside it, and a tool, all in one fake fetch. */
function fakeServer(options: { needsAuth?: boolean; register?: boolean; token?: string; expiresIn?: number } = {}): { fetchFn: Fetch; seen: string[] } {
  const seen: string[] = [];
  const needsAuth = options.needsAuth ?? true;
  const token = options.token ?? "tok-1";
  let refreshed = 0;
  const fetchFn: Fetch = async (url, init) => {
    const u = new URL(url);
    const auth = new Headers(init?.headers).get("authorization") ?? new Headers(init?.headers).get("x-key");
    seen.push(`${init?.method ?? "GET"} ${u.pathname}${auth ? ` [${auth}]` : ""}`);
    if (u.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: "https://mcp.example.com/mcp", authorization_servers: ["https://auth.example.com"] });
    if (u.hostname === "auth.example.com" && u.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({ issuer: "https://auth.example.com", authorization_endpoint: "https://auth.example.com/authorize", token_endpoint: "https://auth.example.com/token", ...(options.register === false ? {} : { registration_endpoint: "https://auth.example.com/register" }), code_challenge_methods_supported: ["S256"], scopes_supported: ["read", "write"] });
    }
    if (u.pathname === "/register") return Response.json({ client_id: "client-1" }, { status: 201 });
    if (u.pathname === "/token") {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "refresh_token") {
        refreshed++;
        return Response.json({ access_token: `tok-refreshed-${refreshed}`, refresh_token: "ref-2", expires_in: 3600 });
      }
      if (form.get("code") !== "code-1" || !form.get("code_verifier")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: token, refresh_token: "ref-1", expires_in: options.expiresIn ?? 3600 });
    }
    if (u.pathname === "/mcp") {
      if (needsAuth && auth !== `Bearer ${token}` && !auth?.startsWith("Bearer tok-refreshed") && auth !== "secret-key") {
        return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"' } });
      }
      const body = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "example" } } }, { headers: { "mcp-session-id": "s1" } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "search", description: "Searches", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { q: { type: "string" } } } }, { name: "create", description: "Creates" }] } });
      if (body.method === "tools/call") return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "found 2" }] } });
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no" } });
    }
    return new Response("no", { status: 404 });
  };
  return { fetchFn, seen };
}

test("secrets are sealed to one connector and never come back out for another", async () => {
  const key = await connectors.sealingKey(KEY);
  assert.ok(key);
  const sealed = await connectors.seal(key, "con_1", { header: "secret-key" });
  assert.deepEqual(await connectors.open(key, "con_1", sealed), { header: "secret-key" });
  assert.equal(await connectors.open(key, "con_2", sealed), null);
  assert.equal(await connectors.sealingKey("short"), null);
  assert.equal(await connectors.sealingKey(undefined), null);
});

test("a connector from the directory signs in with the browser: discovery, registration, PKCE, tokens kept sealed, tools listed, token refreshed when old", async () => {
  const db = fakeD1();
  const { fetchFn, seen } = fakeServer({ expiresIn: 300 });
  const deps: connectors.Deps = { key: await connectors.sealingKey(KEY), fetchFn, site: "https://g1t.sh", now: at };
  // The directory entry's address is Notion's; the fake answers any host, so the flow is what is checked.
  const added = await connectors.addConnector(db, deps, ws, { from: { kind: "address", name: "example", url: "https://mcp.example.com/mcp" }, auth: "oauth" }, "chase");
  assert.ok(added.ok);
  const row = added.value;
  assert.equal(connectors.stateOf(row), "needs_sign_in");
  assert.equal(row.secrets, null);
  const started = await connectors.startSignIn(db, deps, row, "https://g1t.sh/acme/-/customize/connectors/callback");
  assert.ok(started.ok);
  const url = new URL(started.value.url);
  assert.equal(url.origin + url.pathname, "https://auth.example.com/authorize");
  assert.equal(url.searchParams.get("client_id"), "client-1");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("resource"), "https://mcp.example.com/mcp");
  assert.equal(url.searchParams.get("scope"), "read write");
  const state = url.searchParams.get("state")!;
  assert.equal(connectors.connectorOfState(state), row.id);
  assert.ok(seen.some((s) => s.startsWith("POST /register")));
  const pending = (await connectors.connectorById(db, ws, row.id))!;
  const wrong = await connectors.finishSignIn(db, deps, pending, "con_x.nope", "code-1", "chase");
  assert.equal(!wrong.ok && wrong.error.code, "invalid");
  const finished = await connectors.finishSignIn(db, deps, pending, state, "code-1", "chase");
  assert.ok(finished.ok);
  assert.equal(connectors.stateOf(finished.value), "connected");
  assert.equal(finished.value.signed_in_as, "chase");
  assert.equal(finished.value.pending, null);
  assert.deepEqual(JSON.parse(finished.value.tools).map((t: { name: string; kind: string }) => [t.name, t.kind]), [
    ["search", "read"],
    ["create", "write"],
  ]);
  assert.ok(finished.value.secrets && !finished.value.secrets.includes("tok-1"), "the token is sealed");
  // Headers now: the bearer token; later, past expiry, refreshed and kept.
  assert.deepEqual(await connectors.headersFor(db, deps, finished.value), { Authorization: "Bearer tok-1" });
  const later: connectors.Deps = { ...deps, now: new Date(at.getTime() + 400_000) };
  const fresh = (await connectors.connectorById(db, ws, row.id))!;
  assert.deepEqual(await connectors.headersFor(db, later, fresh), { Authorization: "Bearer tok-refreshed-1" });
  assert.deepEqual(await connectors.headersFor(db, later, (await connectors.connectorById(db, ws, row.id))!), { Authorization: "Bearer tok-refreshed-1" }, "the refreshed token was kept");
  // Signed out: needs a sign-in again, and nothing secret remains.
  const out = await connectors.signOut(db, deps, fresh);
  assert.ok(out.ok);
  assert.equal(connectors.stateOf(out.value), "needs_sign_in");
  assert.equal(out.value.secrets, null);
});

test("a connector with a key sends it as a header; without CONNECTORS_KEY no key can be kept", async () => {
  const db = fakeD1();
  const { fetchFn, seen } = fakeServer();
  const deps: connectors.Deps = { key: await connectors.sealingKey(KEY), fetchFn, site: "https://g1t.sh", now: at };
  const added = await connectors.addConnector(db, deps, ws, { from: { kind: "address", name: "keyed", url: "https://mcp.example.com/mcp" }, auth: "header", header: { name: "X-Key", value: "secret-key" } }, "chase");
  assert.ok(added.ok);
  assert.equal(connectors.stateOf(added.value), "connected");
  assert.equal(added.value.header_name, "X-Key");
  assert.equal(JSON.parse(added.value.tools).length, 2);
  assert.ok(seen.some((s) => s.includes("[secret-key]")));
  assert.deepEqual(await connectors.headersFor(db, deps, added.value), { "X-Key": "secret-key" });
  const keyless: connectors.Deps = { ...deps, key: null };
  const refused = await connectors.addConnector(db, keyless, ws, { from: { kind: "address", name: "other", url: "https://mcp.example.com/mcp" }, auth: "header", header: { name: "X-Key", value: "x" } }, "chase");
  assert.equal(!refused.ok && refused.error.code, "invalid");
  // An open server needs nothing.
  const open = await connectors.addConnector(db, deps, ws, { from: { kind: "address", name: "open", url: "https://open.example.com/mcp" }, auth: "none" }, "chase");
  assert.ok(open.ok);
  assert.equal(connectors.stateOf(open.value), "problem", "the fake answers only its own host with tools");
  // Names are unique; a second with the same name gets a number; addresses are checked.
  const again = await connectors.addConnector(db, deps, ws, { from: { kind: "address", name: "keyed", url: "https://mcp.example.com/mcp" }, auth: "none" }, "chase");
  assert.ok(again.ok);
  assert.equal(again.value.name, "keyed-2");
  const local = await connectors.addConnector(db, deps, ws, { from: { kind: "address", name: "local", url: "http://localhost:3000/mcp" }, auth: "none" }, "chase");
  assert.equal(!local.ok && local.error.code, "invalid");
  const directory = await connectors.addConnector(db, deps, ws, { from: { kind: "directory", id: "notion" }, auth: "none" }, "chase");
  assert.ok(directory.ok);
  assert.deepEqual({ name: directory.value.name, title: directory.value.title, auth: directory.value.auth, url: directory.value.url }, { name: "notion", title: "Notion", auth: "oauth", url: "https://mcp.notion.com/mcp" });
  assert.equal(!(await connectors.addConnector(db, deps, ws, { from: { kind: "directory", id: "sentry" }, auth: "none" }, "chase")).ok, true, "only directory entries with a server");
});

test("grants: every agent, a team, one agent; the closest wins; an agent's turn gets connected ones as servers", async () => {
  const db = fakeD1();
  const { fetchFn } = fakeServer();
  const deps: connectors.Deps = { key: await connectors.sealingKey(KEY), fetchFn, site: "https://g1t.sh", now: at };
  const a = (await connectors.addConnector(db, deps, ws, { from: { kind: "address", name: "alpha", url: "https://mcp.example.com/mcp" }, auth: "header", header: { name: "X-Key", value: "secret-key" } }, "chase")) as { ok: true; value: connectors.ConnectorRow };
  const b = (await connectors.addConnector(db, deps, ws, { from: { kind: "address", name: "beta", url: "https://mcp.example.com/mcp" }, auth: "oauth" }, "chase")) as { ok: true; value: connectors.ConnectorRow };
  assert.ok(a.ok && b.ok);
  assert.ok((await connectors.grant(db, deps, ws, a.value.id, "workspace", "", "chase")).ok);
  assert.ok((await connectors.grant(db, deps, ws, a.value.id, "agent", "agt_1", "chase")).ok);
  assert.ok((await connectors.grant(db, deps, ws, b.value.id, "team", "qa", "chase")).ok);
  const same = await connectors.grant(db, deps, ws, a.value.id, "workspace", "", "ana");
  assert.ok(same.ok && same.value.granted_by === "chase", "the same grant twice is one");
  const reach = await connectors.reaching(db, ws, "agt_1", ["qa"]);
  assert.deepEqual(
    reach.map((r) => [r.row.name, r.via]),
    [
      ["alpha", "agent"],
      ["beta", "team"],
    ],
  );
  assert.deepEqual((await connectors.reaching(db, ws, "agt_2", [])).map((r) => [r.row.name, r.via]), [["alpha", "workspace"]]);
  const server = connectors.asServer(a.value);
  assert.equal(server.id, a.value.id);
  assert.equal(server.tools.length, 2);
  const lines = connectors.agentConnectorsOut(reach, [], { teamName: (slug) => slug.toUpperCase() });
  assert.deepEqual(
    lines.map((l) => [l.name, l.state, l.via_label, l.tools]),
    [
      ["alpha", "connected", "This agent", 2],
      ["beta", "needs_sign_in", "Team BETA", 0],
    ],
  );
  const labels = { agents: new Map([["agt_1", { handle: "otto", display_name: "Otto" }]]), teams: new Map([["qa", "Quality"]]) };
  const out = await connectors.connectorsOut(db, ws, labels);
  assert.deepEqual(out.find((c) => c.name === "alpha")!.grants.map((g) => g.label), ["Every agent", "@otto"]);
  assert.deepEqual(out.find((c) => c.name === "beta")!.grants.map((g) => g.label), ["Quality"]);
  const grantId = out.find((c) => c.name === "alpha")!.grants[1]!.id;
  assert.ok((await connectors.revoke(db, ws, grantId)).ok);
  assert.deepEqual((await connectors.reaching(db, ws, "agt_1", [])).map((r) => r.via), ["workspace"]);
  // Removed: gone from agents at once, with its grants and secrets.
  assert.ok((await connectors.removeConnector(db, deps, ws, a.value.id)).ok);
  assert.deepEqual((await connectors.reaching(db, ws, "agt_1", ["qa"])).map((r) => [r.row.id, r.via]), [[b.value.id, "team"]]);
  assert.equal((await db.prepare("SELECT secrets FROM connectors WHERE id = ?").bind(a.value.id).first<{ secrets: string | null }>())!.secrets, null);
});

test("a switched-off plugin's connectors stop reaching agents; switched on, they are back", async () => {
  const db = fakeD1();
  const { fetchFn } = fakeServer();
  const deps: connectors.Deps = { key: await connectors.sealingKey(KEY), fetchFn, site: "https://g1t.sh", now: at };
  await db
    .prepare("INSERT INTO plugin_installs (id, workspace_id, ref, name, marketplace, description, fetch, installed_by, installed_at, updated_at, enabled) VALUES ('plg_1', ?, 'release@acme', 'release', 'acme', '', '{}', 'chase', ?, ?, 1)")
    .bind(ws, at.toISOString(), at.toISOString())
    .run();
  const fromPlugin = (await connectors.addConnector(db, deps, ws, { from: { kind: "plugin", ref: "release@acme", server: "tracker" }, auth: "header", header: { name: "X-Key", value: "secret-key" } }, "chase", { title: "Release: tracker", url: "https://mcp.example.com/mcp" })) as { ok: true; value: connectors.ConnectorRow };
  const byHand = (await connectors.addConnector(db, deps, ws, { from: { kind: "address", name: "mine", url: "https://mcp.example.com/mcp" }, auth: "header", header: { name: "X-Key", value: "secret-key" } }, "chase")) as { ok: true; value: connectors.ConnectorRow };
  assert.ok(fromPlugin.ok && byHand.ok);
  await connectors.grant(db, deps, ws, fromPlugin.value.id, "workspace", "", "chase");
  await connectors.grant(db, deps, ws, byHand.value.id, "workspace", "", "chase");
  assert.deepEqual((await connectors.reaching(db, ws, "agt_1", [])).map((r) => r.row.name).sort(), ["mine", "tracker"]);
  await db.prepare("UPDATE plugin_installs SET enabled = 0 WHERE id = 'plg_1'").run();
  assert.deepEqual((await connectors.reaching(db, ws, "agt_1", [])).map((r) => r.row.name), ["mine"]);
  await db.prepare("UPDATE plugin_installs SET enabled = 1 WHERE id = 'plg_1'").run();
  assert.equal((await connectors.reaching(db, ws, "agt_1", [])).length, 2);
});
