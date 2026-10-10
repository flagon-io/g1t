import assert from "node:assert/strict";
import { test } from "node:test";

import type { AbilitySection, McpServer, User } from "@g1t/contracts";

import { resolveAbilities, withSetting } from "../../../packages/contracts/src/abilities.ts";
import { CONNECTORS } from "../../../packages/contracts/src/connectors.ts";
import { abilitiesSection, saidText } from "./abilities-prompt.ts";
import { Audience, type AudienceInfo, type AudiencePorts, type RepoRef } from "./audience.ts";
import { abilityCard, connectCard, requestCard } from "./card-views.ts";
import { DEFAULT_AUTONOMY, applyChanges } from "./definition.ts";
import { callMcpTool, listMcpTools } from "./mcp-client.ts";
import { type AbilityPorts, type ActionPorts, type ToolPorts, ToolBox } from "./tools.ts";

// ── A small world ────────────────────────────────────────────────────────

const WEB: RepoRef = { id: "rep_web", namespace: "acme", name: "web", isPrivate: true, defaultBranch: "main" };
const person = (id: string): User => ({ id, username: id, workspaces: [{ slug: "acme", role: "member" }] }) as User;

function world(): AudiencePorts {
  const info: AudienceInfo = { kind: "dm", member_user_ids: ["asker"], member_count: 1 };
  return {
    info: async () => info,
    users: async (ids) => [person("asker")].filter((u) => ids.includes(u.id)),
    workspaceRepos: async () => [WEB],
    readable: async (ids) => [WEB].filter((r) => ids.includes(r.id)),
  };
}

const ports: ToolPorts = {
  readFile: async () => null,
  searchCode: async () => [],
  listIssues: async () => [],
  getIssue: async () => null,
  getPull: async () => null,
  recentPulls: async () => [],
  searchMessages: async () => [],
  readThread: async () => null,
  roster: async () => "",
  consult: async () => ({ ok: false, message: "no" }),
};

const actions: ActionPorts = {
  remember: async () => ({ ok: true, message: "" }),
  forget: async () => ({ ok: true, message: "" }),
  draftIssue: async () => ({ ok: true, message: "" }),
};

const ITEMS: Record<string, { provider: string; key: string; title: string; url: string; status: string | null; body: string }> = {
  "ENG-42": { provider: "linear", key: "ENG-42", title: "Retry flaky checks", url: "https://linear.app/acme/issue/ENG-42", status: "In Progress", body: "The queue retries." },
  "TECH-7": { provider: "jira", key: "TECH-7", title: "Login timeout", url: "https://acme.atlassian.net/browse/TECH-7", status: "To Do", body: "Times out." },
};

type Posted = { kind: string; title: string };

/** Ports that record what they were asked to do. */
function fakeAbilityPorts(over: Partial<AbilityPorts> = {}): AbilityPorts & { posted: Posted[]; acted: string[]; refusals: string[] } {
  const posted: Posted[] = [];
  const acted: string[] = [];
  const refusals: string[] = [];
  return {
    posted,
    acted,
    refusals,
    lookup: async (_asker, reference) => (ITEMS[reference] ? { ok: true, value: ITEMS[reference]! } : { ok: false, code: "not_found", message: "None of the acme workspace's integrations knows that." }),
    import: async (_asker, repo, reference) => ({ ok: true, value: { number: 7, item: ITEMS[reference]!, created: true } }),
    act: async (_asker, reference, action, text) => {
      acted.push(`${action} ${reference}: ${text}`);
      return { ok: true, value: ITEMS[reference]! };
    },
    askerConnected: async () => false,
    mcp: async (server, tool, args) => {
      acted.push(`mcp ${server.name}.${tool.name} ${JSON.stringify(args)}`);
      return { ok: true, value: "sunny" };
    },
    askFirst: async ({ summary }) => {
      posted.push({ kind: "ability", title: summary });
      return "abr_1";
    },
    connect: async (source) => {
      posted.push({ kind: "connect", title: source.name });
      return true;
    },
    request: async ({ connector, ability }) => {
      posted.push({ kind: "request", title: connector ?? ability?.id ?? "" });
      return true;
    },
    refused: ({ rule }) => {
      refusals.push(rule);
    },
    ...over,
  };
}

const SERVER: McpServer = {
  id: "mcp_w",
  name: "weather",
  url: "https://mcp.example.com/",
  tools: [
    { name: "get_forecast", description: "Today's forecast", kind: "read", input_schema: { type: "object", properties: { city: { type: "string" } } } },
    { name: "set_alert", description: "Set an alert", kind: "write", input_schema: { type: "object", properties: {} } },
  ],
  added_by: "ana",
  added_at: "2026-10-10T00:00:00.000Z",
  checked_at: null,
  problem: null,
};

async function box(input: { connected?: string[]; settings?: Record<string, { level?: "alone" | "asked" | "ask" | "never"; credentials?: "workspace" | "asker" }>; servers?: McpServer[]; said?: string; session?: boolean; ports?: Partial<AbilityPorts> }) {
  const audience = await Audience.build("acme", "asker", world());
  const tools = new ToolBox(audience, ports, { agentId: "agt_me", notConsult: ["me"], hops: 0, maxHops: 6, session: input.session }, [], actions);
  let abilities = { settings: {}, mcp_servers: input.servers ?? [] };
  for (const [id, setting] of Object.entries(input.settings ?? {})) abilities = withSetting(abilities, id, setting);
  const sections: AbilitySection[] = resolveAbilities({ connectors: CONNECTORS, abilities, autonomy: DEFAULT_AUTONOMY, connected: input.connected ?? [] });
  const fake = fakeAbilityPorts(input.ports);
  tools.useAbilities(sections, fake, input.said ?? "", input.servers ?? []);
  return { tools, fake, sections };
}

const names = (tools: ToolBox) => tools.definitions().map((t) => t.name);

// ── Offering ─────────────────────────────────────────────────────────────

test("nothing connected: no outside tools but request_ability; a connected Linear offers lookup, import and act", async () => {
  const none = await box({});
  assert.ok(!names(none.tools).includes("lookup_outside"));
  assert.ok(names(none.tools).includes("request_ability"), "it can still ask for what it lacks");
  const linear = await box({ connected: ["linear"] });
  for (const tool of ["lookup_outside", "import_outside", "act_outside"]) assert.ok(names(linear.tools).includes(tool), tool);
});

test("an ability set to Never isn't offered when it is the only one for its tool, and is refused with the rule if called anyway", async () => {
  const { tools, fake } = await box({ connected: ["linear"], settings: { "integration:linear:comment": { level: "never" } } });
  assert.ok(!names(tools).includes("act_outside"), "Linear's only act ability is Never");
  const tried = await tools.run("act_outside", { reference: "ENG-42", action: "comment", text: "hi" });
  assert.equal(tried.outcome, "refused");
  assert.match(tried.text, /no tool called act_outside/);
  assert.deepEqual(fake.acted, []);
});

test("Never on one system, allowed on another: the tool is offered, and the rule is named per call, in the result and the audit log", async () => {
  const { tools, fake } = await box({ connected: ["linear", "jira"], settings: { "integration:linear:comment": { level: "never" }, "integration:jira:comment": { level: "alone" } } });
  assert.ok(names(tools).includes("act_outside"));
  const linear = await tools.run("act_outside", { reference: "ENG-42", action: "comment", text: "Looks fixed." });
  assert.equal(linear.outcome, "refused");
  assert.match(linear.text, /Not allowed: your abilities say "Linear: Comment" is Never/);
  assert.deepEqual(fake.refusals, ["integration:linear:comment=never"]);
  assert.deepEqual(fake.acted, [], "nothing ran");
  const jira = await tools.run("act_outside", { reference: "TECH-7", action: "comment", text: "On it." });
  assert.equal(jira.outcome, "allowed");
  assert.deepEqual(fake.acted, ["comment TECH-7: On it."]);
  assert.equal(tools.calls.length, 2, "both calls are in the transcript");
  assert.equal(tools.calls[0]!.outcome, "refused");
});

test("reading is alone by default; an item nobody knows is not found, and a system that isn't connected is said so", async () => {
  const { tools } = await box({ connected: ["linear"] });
  const read = await tools.run("lookup_outside", { reference: "ENG-42" });
  assert.equal(read.outcome, "allowed");
  assert.match(read.text, /<untrusted source="Linear ENG-42">/);
  assert.match(read.text, /Retry flaky checks/);
  const missing = await tools.run("lookup_outside", { reference: "NOPE-1" });
  assert.equal(missing.outcome, "refused");
  assert.match(missing.text, /No connected integration knows NOPE-1/);
  // Jira knows TECH-7, but Jira isn't connected to this workspace as the agent sees it.
  const jira = await tools.run("lookup_outside", { reference: "TECH-7" });
  assert.equal(jira.outcome, "refused");
  assert.match(jira.text, /Jira isn't connected to this workspace, so you can't read tickets there/);
});

// ── Ask first, and alone when asked for it ───────────────────────────────

test("Ask first posts the card with the call, runs nothing, and tells the agent to wait; a session is told it pauses", async () => {
  const { tools, fake } = await box({ connected: ["linear"], session: true });
  const tried = await tools.run("act_outside", { reference: "ENG-42", action: "comment", text: "Fixed in #412." });
  assert.equal(tried.outcome, "refused");
  assert.match(tried.text, /"Linear: Comment" is after asking first: a card was posted asking @asker \(or an owner\)/);
  assert.match(tried.text, /Your session pauses/);
  assert.deepEqual(fake.posted, [{ kind: "ability", title: "Comment on ENG-42 in Linear" }]);
  assert.deepEqual(fake.acted, []);
  assert.deepEqual(fake.refusals, ["integration:linear:comment=ask"]);
});

test("alone when asked for it: runs when the person named the item, asks first when they didn't", async () => {
  const asked = await box({ connected: ["linear"], said: "Please import ENG-42 into web so we can track it here." });
  const ran = await asked.tools.run("import_outside", { repo: "web", reference: "ENG-42" });
  assert.equal(ran.outcome, "allowed");
  assert.match(ran.text, /Opened acme\/web#7 from ENG-42/);
  assert.deepEqual(asked.fake.posted, []);
  const unasked = await box({ connected: ["linear"], said: "What's the state of the queue work?" });
  const held = await unasked.tools.run("import_outside", { repo: "web", reference: "ENG-42" });
  assert.equal(held.outcome, "refused");
  assert.match(held.text, /^Import issues in Linear runs on its own only when asked for it, and this wasn't\. "Linear: Import issues" is only when the person asked for that: a card was posted/);
  assert.deepEqual(unasked.fake.posted, [{ kind: "ability", title: "Import ENG-42 from Linear into acme/web" }]);
});

test("when the card can't be posted, the agent is told to ask in words", async () => {
  const { tools } = await box({ connected: ["linear"], ports: { askFirst: async () => null } });
  const tried = await tools.run("act_outside", { reference: "ENG-42", action: "comment", text: "x" });
  assert.match(tried.text, /couldn't be posted just now/);
});

// ── Whose connection ─────────────────────────────────────────────────────

test("the asker's own connection, missing: a Connect card, nothing runs, and the audit log says why", async () => {
  const { tools, fake } = await box({ connected: ["linear"], settings: { "integration:linear:read": { credentials: "asker" } } });
  const tried = await tools.run("lookup_outside", { reference: "ENG-42" });
  assert.equal(tried.outcome, "refused");
  assert.match(tried.text, /runs on @asker's own Linear connection, and they haven't connected one. A Connect card was posted/);
  assert.deepEqual(fake.posted, [{ kind: "connect", title: "Linear" }]);
  assert.deepEqual(fake.refusals, ["integration:linear:read=asker-not-connected"]);
  const connected = await box({ connected: ["linear"], settings: { "integration:linear:read": { credentials: "asker" } }, ports: { askerConnected: async () => true } });
  assert.equal((await connected.tools.run("lookup_outside", { reference: "ENG-42" })).outcome, "allowed");
});

// ── Requests ─────────────────────────────────────────────────────────────

test("request_ability posts a Request card for an integration that isn't connected, or an ability by its id", async () => {
  const { tools, fake } = await box({ connected: ["linear"], settings: { "integration:linear:comment": { level: "never" } } });
  const jira = await tools.run("request_ability", { needs: "jira", why: "Support files bugs there." });
  assert.equal(jira.outcome, "allowed");
  const comment = await tools.run("request_ability", { needs: "integration:linear:comment", why: "To tell the team when it's fixed." });
  assert.equal(comment.outcome, "allowed");
  assert.deepEqual(fake.posted, [
    { kind: "request", title: "jira" },
    { kind: "request", title: "integration:linear:comment" },
  ]);
  const bad = await tools.run("request_ability", { needs: "", why: "" });
  assert.equal(bad.outcome, "refused");
});

// ── MCP ──────────────────────────────────────────────────────────────────

test("an MCP server's tools are offered as <server>__<tool> with the server's schema; reads run alone, writes ask first, Never withholds", async () => {
  const { tools, fake } = await box({ servers: [SERVER] });
  const forecast = tools.definitions().find((t) => t.name === "weather__get_forecast");
  assert.ok(forecast, "offered");
  assert.deepEqual(forecast!.input_schema, SERVER.tools[0]!.input_schema);
  assert.match(forecast!.description, /it reads/);
  const read = await tools.run("weather__get_forecast", { city: "Lisbon" });
  assert.equal(read.outcome, "allowed");
  assert.match(read.text, /<untrusted source="weather get_forecast">\nsunny/);
  const write = await tools.run("weather__set_alert", {});
  assert.equal(write.outcome, "refused");
  assert.match(write.text, /"weather: set_alert" is after asking first/);
  assert.deepEqual(fake.posted, [{ kind: "ability", title: "Call set_alert on weather" }]);
  const never = await box({ servers: [SERVER], settings: { "mcp:mcp_w:set_alert": { level: "never" } } });
  assert.ok(!names(never.tools).includes("weather__set_alert"), "not offered at all");
  assert.equal((await never.tools.run("weather__set_alert", {})).outcome, "refused");
});

// ── The prompt and what was said ─────────────────────────────────────────

test("the prompt's abilities section names each connected system's rows and levels, and what isn't connected", async () => {
  const { sections } = await box({ connected: ["linear"], settings: { "integration:linear:comment": { level: "never" } }, servers: [SERVER] });
  const text = abilitiesSection(sections)!;
  assert.match(text, /- Linear: read issues on your own; import issues on your own only when they asked for it, else it asks first; comment never\./);
  assert.match(text, /- weather: get_forecast on your own; set_alert asks first \(a card\)\./);
  assert.match(text, /Not connected to this workspace: Jira, Sentry\./);
  assert.equal(saidText([null, "  ", "a", "b"]), "a\nb");
});

// ── The definition ───────────────────────────────────────────────────────

test("a definition keeps ability settings it knows, within each kind's limit, and never above Ask for a restricted one", () => {
  const base = applyChanges(null, { handle: "margo", display_name: "Margo", title: "QA", instructions: "Test." }, []);
  assert.ok(base.ok);
  const changed = applyChanges(base.value, { abilities: { settings: { "integration:linear:comment": { level: "alone", credentials: "asker" } } } }, []);
  assert.ok(changed.ok);
  assert.deepEqual(changed.value.abilities, { settings: { "integration:linear:comment": { level: "alone", credentials: "asker" } }, mcp_servers: [] });
  const unknown = applyChanges(base.value, { abilities: { settings: { "integration:slack:post": { level: "alone" } } } }, []);
  assert.ok(!unknown.ok && /no ability called integration:slack:post/.test(unknown.message));
  const badLevel = applyChanges(base.value, { abilities: { settings: { "integration:linear:read": { level: "loud" as never } } } }, []);
  assert.ok(!badLevel.ok);
  const notIntegration = applyChanges(base.value, { abilities: { settings: { "mcp:mcp_w:get_forecast": { level: "ask" } } } }, []);
  assert.ok(!notIntegration.ok, "no such server on the agent");
  // With the server, its tools are abilities; removing the server drops their settings.
  const withServer = applyChanges(base.value, { abilities: { settings: { "mcp:mcp_w:get_forecast": { level: "ask" } } } }, [], { mcp_servers: [SERVER] });
  assert.ok(withServer.ok);
  assert.equal(withServer.value.abilities.mcp_servers.length, 1);
  assert.deepEqual(withServer.value.abilities.settings, { "mcp:mcp_w:get_forecast": { level: "ask" } });
  const without = applyChanges(withServer.value, {}, [], { mcp_servers: [] });
  assert.ok(without.ok);
  assert.deepEqual(without.value.abilities, { settings: {}, mcp_servers: [] });
  const g1t = applyChanges(base.value, { abilities: { settings: { "g1t:merge": { level: "alone" } } } }, []);
  assert.ok(!g1t.ok, "g1t's own keep their choices in autonomy");
});

// ── Cards ────────────────────────────────────────────────────────────────

test("the Ask-first, Connect and Request cards say what they are for and offer the right buttons", () => {
  const waiting = abilityCard({ id: "abr_1", summary: "Comment on ENG-42 in Linear", status: "pending", decided_by: null, result: null, ability: "integration:linear:comment" }, { agent: "Margo", asker: "ana", rule: "Linear: Comment", level: "ask", note: null, body: "Fixed in #412." });
  assert.equal(waiting.state, "Waiting");
  assert.deepEqual(waiting.actions?.map((a) => a.id), ["allow", "deny"]);
  assert.equal(waiting.owner, "agents");
  assert.equal(waiting.body, "Fixed in #412.");
  const done = abilityCard({ id: "abr_1", summary: "Comment on ENG-42 in Linear", status: "allowed", decided_by: "ana", result: "Commented on ENG-42.", ability: "integration:linear:comment" }, { agent: "Margo", asker: "ana", rule: "Linear: Comment", level: "ask", note: null, body: null });
  assert.equal(done.state, "Done");
  assert.equal(done.actions, undefined);
  const connect = connectCard({ connector: "Linear", agent: "Margo", ability: "Read issues", asker: "ana", href: "/settings/integrations" });
  assert.equal(connect.actions?.[0]?.href, "/settings/integrations");
  assert.equal(connect.owner, null, "a link, no action for the service");
  const request = requestCard({ agent: { id: "a1", handle: "margo", display_name: "Margo" }, workspace: "acme", connector: { id: "jira", name: "Jira", available: true }, ability: null, why: "Support files bugs there.", status: "open", by: null });
  assert.deepEqual(request.actions?.map((a) => a.id), ["ask", "open"]);
  assert.equal(request.ref, "connector:a1:jira");
  const asked = requestCard({ agent: { id: "a1", handle: "margo", display_name: "Margo" }, workspace: "acme", connector: null, ability: { id: "integration:linear:comment", label: "Linear: Comment" }, why: "x", status: "asked", by: "bo" });
  assert.equal(asked.state, "Asked");
  assert.equal(asked.actions?.[0]?.href, "/acme/-/agents/margo/abilities");
});

// ── The MCP client ───────────────────────────────────────────────────────

test("the MCP client lists tools (reads by readOnlyHint) and calls one, over JSON or an event stream", async () => {
  const seen: { method: string; session: string | null }[] = [];
  const fetchFn = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id?: number; method: string; params?: { name?: string } };
    seen.push({ method: body.method, session: (init.headers as Record<string, string>)["mcp-session-id"] ?? null });
    const answer = (result: unknown, sse = false) =>
      new Response(sse ? `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n` : JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": sse ? "text/event-stream" : "application/json", "mcp-session-id": "s1" },
      });
    if (body.method === "initialize") return answer({ protocolVersion: "2025-06-18" });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") {
      return answer(
        {
          tools: [
            { name: "get_forecast", description: "Forecast", inputSchema: { type: "object", properties: { city: { type: "string" } } }, annotations: { readOnlyHint: true } },
            { name: "set_alert", description: "Alert" },
            { name: "bad name!" },
          ],
        },
        true,
      );
    }
    if (body.method === "tools/call") return answer({ content: [{ type: "text", text: `sunny in ${JSON.stringify(body.params)}` }] });
    return new Response("{}", { status: 404 });
  };
  const listed = await listMcpTools("https://mcp.example.com/", fetchFn);
  assert.ok(listed.ok);
  assert.deepEqual(
    listed.tools.map((t) => [t.name, t.kind]),
    [
      ["get_forecast", "read"],
      ["set_alert", "write"],
    ],
  );
  assert.deepEqual(listed.tools[1]!.input_schema, { type: "object", properties: {} });
  assert.equal(seen[2]!.session, "s1", "the session id the server gave rides along");
  const called = await callMcpTool("https://mcp.example.com/", "get_forecast", { city: "Lisbon" }, fetchFn);
  assert.ok(called.ok);
  assert.match(called.text, /sunny in \{"name":"get_forecast","arguments":\{"city":"Lisbon"\}\}/);
  const down = await listMcpTools("https://mcp.example.com/", async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.ok(!down.ok && /couldn't be reached/.test(down.message));
  const errored = await callMcpTool("https://mcp.example.com/", "x", {}, async (_u, init) => {
    const body = JSON.parse(String(init.body)) as { id?: number; method: string };
    if (body.method === "tools/call") return Response.json({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "no such city" }] } });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
  });
  assert.ok(!errored.ok && errored.message === "no such city");
});
