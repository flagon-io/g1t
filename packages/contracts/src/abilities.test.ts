import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ABILITY_LEVELS,
  COMPUTER_ABILITIES,
  G1T_ABILITIES,
  abilitiesSummary,
  allAbilities,
  askedFor,
  autonomyOfLevel,
  checkMcpName,
  checkMcpUrl,
  connectorsWithAbilities,
  defaultLevel,
  findAbility,
  integrationAbilities,
  levelOfAutonomy,
  maxLevel,
  mcpAbility,
  mcpToolName,
  resolveAbilities,
  withSetting,
  withinLevel,
} from "./abilities.ts";
import { CONNECTORS } from "./connectors.ts";

const AUTONOMY = { open_pull_requests: "alone", merge: "approval", deploy_production: "approval", edit_docs: "suggest" } as const;
const resolve = (over: Partial<Parameters<typeof resolveAbilities>[0]> = {}) => resolveAbilities({ connectors: CONNECTORS, abilities: null, autonomy: AUTONOMY, connected: [], ...over });

test("defaults by kind: reads alone, writes inside g1t when asked for, sending outside asks first, restricted never and no freer than asking", () => {
  assert.equal(defaultLevel("read"), "alone");
  assert.equal(defaultLevel("write"), "asked");
  assert.equal(defaultLevel("send"), "ask");
  assert.equal(defaultLevel("restricted"), "never");
  assert.equal(maxLevel("restricted"), "ask");
  assert.equal(maxLevel("send"), "alone");
  assert.ok(withinLevel("never", "ask"));
  assert.ok(!withinLevel("alone", "ask"));
  assert.deepEqual(ABILITY_LEVELS, ["alone", "asked", "ask", "never"]);
});

test("every integration ability belongs to an available workspace connector with a provider, and its kind fits the connector's capabilities", () => {
  const withAbilities = connectorsWithAbilities(CONNECTORS);
  assert.ok(withAbilities.length >= 3, "Linear, Jira and Sentry at least");
  for (const connector of withAbilities) {
    assert.equal(connector.status, "available", `${connector.id} is connectable today`);
    assert.ok(connector.scopes.includes("workspace"), `${connector.id} connects for a workspace`);
    assert.ok(connector.provider, `${connector.id} has a provider the integrations service knows`);
    const defs = integrationAbilities(connector.id);
    const caps = connector.capabilities ?? [];
    if (defs.some((d) => d.kind === "read")) assert.ok(caps.includes("Agents can read"), `${connector.id} says agents can read`);
    if (defs.some((d) => d.kind === "send")) assert.ok(caps.includes("Writes back"), `${connector.id} says it writes back`);
    for (const def of defs) {
      assert.equal(def.id, `integration:${connector.id}:${def.id.split(":")[2]}`);
      assert.equal(def.tools.length, 1, "one tool per integration ability");
    }
  }
  assert.deepEqual(integrationAbilities("datadog"), [], "Datadog opens issues by itself: nothing for an agent to call");
});

test("g1t's own are always on and the four autonomy ones keep their choices as levels", () => {
  const sections = resolve();
  const g1t = sections.find((s) => s.group === "g1t")!;
  const artifacts = g1t.sources[0]!.abilities.find((a) => a.id === "g1t:artifacts")!;
  assert.equal(artifacts.level, "alone");
  assert.equal(artifacts.can_change, false);
  const merge = g1t.sources[0]!.abilities.find((a) => a.id === "g1t:merge")!;
  assert.equal(merge.level, "ask", "approval reads as Ask first");
  assert.deepEqual(merge.choices, ["alone", "ask", "never"]);
  const deploy = g1t.sources[0]!.abilities.find((a) => a.id === "g1t:deploy")!;
  assert.equal(deploy.kind, "restricted");
  assert.ok(!deploy.choices.includes("alone"), "production deploys never go alone");
  assert.equal(levelOfAutonomy("suggest"), "ask");
  assert.equal(autonomyOfLevel("edit_docs", "ask"), "suggest");
  assert.equal(autonomyOfLevel("merge", "ask"), "approval");
  assert.equal(autonomyOfLevel("merge", "never"), "never");
  assert.equal(G1T_ABILITIES.filter((d) => d.autonomy).length, 4);
  const computer = sections.find((s) => s.group === "computer")!;
  assert.ok(computer.sources[0]!.abilities.every((a) => a.status === "coming" && a.choices.length === 0 && !a.can_change));
  assert.equal(COMPUTER_ABILITIES.length, 4);
});

test("a connected integration lists its rows at their defaults; one that isn't is listed, but nothing there can be changed", () => {
  const sections = resolve({ connected: ["linear"] });
  const integrations = sections.find((s) => s.group === "integration")!;
  const linear = integrations.sources.find((s) => s.id === "linear")!;
  assert.equal(linear.connected, true);
  assert.deepEqual(
    linear.abilities.map((a) => [a.id, a.level, a.credentials, a.can_change]),
    [
      ["integration:linear:read", "alone", "workspace", true],
      ["integration:linear:import", "asked", "workspace", true],
      ["integration:linear:comment", "ask", "workspace", true],
    ],
  );
  assert.equal(linear.abilities[0]!.personal_available, false, "Linear's personal side is still coming");
  const jira = integrations.sources.find((s) => s.id === "jira")!;
  assert.equal(jira.connected, false);
  assert.ok(jira.abilities.every((a) => !a.can_change));
  assert.equal(integrations.sources[0]!.id, "linear", "connected first");
  assert.ok(!integrations.sources.some((s) => s.id === "webhooks" || s.id === "anthropic"), "nothing to call, not connected: not listed");
  const withDatadog = resolve({ connected: ["datadog"] }).find((s) => s.group === "integration")!;
  const datadog = withDatadog.sources.find((s) => s.id === "datadog")!;
  assert.equal(datadog.abilities.length, 0);
  assert.match(datadog.note ?? "", /Opens issues by itself/);
});

test("a setting moves a level within its kind's limit, and is dropped when it is the default again", () => {
  let abilities = withSetting(null, "integration:linear:comment", { level: "alone" });
  assert.deepEqual(abilities.settings, { "integration:linear:comment": { level: "alone" } });
  const sections = resolve({ connected: ["linear"], abilities });
  assert.equal(findAbility(sections, "integration:linear:comment")!.ability.level, "alone");
  abilities = withSetting(abilities, "integration:linear:comment", { credentials: "asker" });
  assert.deepEqual(abilities.settings["integration:linear:comment"], { level: "alone", credentials: "asker" });
  abilities = withSetting(abilities, "integration:linear:comment", { level: null, credentials: null });
  assert.deepEqual(abilities.settings, {}, "nothing kept once everything is the default");
  // A restricted ability set freer than Ask is held at Ask.
  const held = resolveAbilities({ connectors: CONNECTORS, abilities: null, autonomy: { ...AUTONOMY, deploy_production: "approval" }, connected: [] });
  assert.equal(findAbility(held, "g1t:deploy")!.ability.max, "ask");
});

test("a personal agent runs on the asker's connections unless an owner chose the workspace's", () => {
  const sections = resolve({ connected: ["linear"], personal: true });
  assert.equal(findAbility(sections, "integration:linear:read")!.ability.credentials, "asker");
  const chosen = resolve({ connected: ["linear"], personal: true, abilities: withSetting(null, "integration:linear:read", { credentials: "workspace" }) });
  assert.equal(findAbility(chosen, "integration:linear:read")!.ability.credentials, "workspace");
});

test("MCP servers: each listed tool is a row, a write unless the server says it reads, offered under <server>__<tool>", () => {
  const server = {
    id: "mcp_1",
    name: "weather",
    url: "https://mcp.example.com/",
    tools: [
      { name: "get_forecast", description: "Today's forecast", kind: "read" as const, input_schema: { type: "object", properties: {} } },
      { name: "set_alert", description: "", kind: "write" as const, input_schema: { type: "object", properties: {} } },
    ],
    added_by: "ana",
    added_at: "2026-10-10T00:00:00.000Z",
    checked_at: null,
    problem: null,
  };
  const sections = resolve({ abilities: { settings: {}, mcp_servers: [server] } });
  const mcp = sections.find((s) => s.group === "mcp")!;
  assert.equal(mcp.sources.length, 1);
  const [read, write] = mcp.sources[0]!.abilities;
  assert.equal(read!.level, "alone");
  assert.equal(write!.level, "ask", "a write outside g1t asks first");
  assert.equal(write!.kind, "send");
  assert.deepEqual(read!.tools, ["weather__get_forecast"]);
  assert.equal(mcpToolName("My Server", "do.thing"), "my_server__do_thing");
  assert.equal(mcpAbility(server, server.tools[1]!).id, "mcp:mcp_1:set_alert");
});

test("an MCP server's address is HTTPS on a public host, never local, an address or g1t's own", () => {
  assert.equal(checkMcpUrl("https://mcp.example.com/sse").ok, true);
  assert.equal(checkMcpUrl("http://mcp.example.com/").ok, false);
  assert.equal(checkMcpUrl("https://localhost:3000/").ok, false);
  assert.equal(checkMcpUrl("https://10.0.0.5/").ok, false);
  assert.equal(checkMcpUrl("https://[::1]/").ok, false);
  assert.equal(checkMcpUrl("https://mcp.internal/").ok, false);
  assert.equal(checkMcpUrl("https://api.g1t.sh/mcp").ok, false);
  assert.equal(checkMcpUrl("https://user:pw@mcp.example.com/").ok, false);
  assert.equal(checkMcpUrl("not a url").ok, false);
  assert.equal(checkMcpName("Weather").ok, true);
  assert.equal(checkMcpName("a").ok, false);
  assert.equal(checkMcpName("bad name").ok, false);
});

test("alone when asked for it: the item's key or the ability's name in what the person said", () => {
  assert.ok(askedFor("Can you comment on ENG-42 with the test plan?", ["ENG-42", "comment"]));
  assert.ok(askedFor("what's eng-42 about", ["ENG-42"]), "any case");
  assert.ok(!askedFor("Summarise the thread", ["ENG-42", "import"]));
  assert.ok(!askedFor("", ["ENG-42"]));
});

test("the summary says what it does alone, when asked, after asking, and never", () => {
  const abilities = withSetting(withSetting(null, "integration:linear:comment", { level: "never" }), "integration:sentry:resolve", { level: "alone" });
  const sections = resolve({ connected: ["linear", "sentry"], abilities });
  const summary = abilitiesSummary(sections);
  assert.equal(
    summary,
    "Can open pull requests, read issues in Linear, read issues in Sentry and resolve issues in Sentry on its own; imports issues in Linear and imports issues in Sentry when asked for it; asks before merging, deploying to production, editing docs and commenting in Sentry; never comments in Linear.",
  );
  assert.equal(allAbilities(sections).filter((a) => a.group === "integration" && a.can_change).length, 7);
  assert.match(abilitiesSummary(resolve()), /open pull requests on its own/);
});
