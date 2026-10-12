import assert from "node:assert/strict";
import { test } from "node:test";

import type { InstallRequest, PluginComponents, PluginListing, SkillListing, WorkspaceConnector } from "@g1t/contracts";
import { connectorsFor } from "@g1t/contracts/connectors";

import {
  addPath,
  availabilityWord,
  categoriesOf,
  claudeCodeOnly,
  componentChips,
  connectorCallbackPath,
  connectorNewPath,
  connectorPagePath,
  connectorsDirectory,
  customizeForm,
  fetchWords,
  filterPlugins,
  filterSkills,
  flashOf,
  fromWords,
  groupByMarketplace,
  kindWord,
  matches,
  needsReload,
  openRequests,
  personalDirectory,
  pluginAgentDraft,
  pluginListingRef,
  pluginPath,
  reachOptions,
  reachWords,
  readPluginFilters,
  readQuery,
  readView,
  requestedBy,
  skillListingRef,
  splitTarget,
  tabOf,
  titleOf,
  waitingFor,
  withParams,
} from "./customize.ts";
import { modeOf, workspaceRedirect } from "./workspace-nav.ts";

const request = (listing: string, by: string, status: InstallRequest["status"] = "open"): InstallRequest => ({
  id: `ins_${listing}_${by}`,
  listing,
  kind: listing.startsWith("plugin:") ? "plugin" : listing.startsWith("skill:") ? "skill" : listing.startsWith("connector:") ? "connector" : "integration",
  name: listing,
  note: null,
  requested_by: by,
  requested_at: "2026-10-10T12:00:00Z",
  status,
  resolved_by: null,
  resolved_at: null,
});

const plugin = (name: string, marketplace: string, extra: Partial<PluginListing> = {}): PluginListing => ({
  ref: `${name}@${marketplace}`,
  name,
  marketplace,
  display_name: null,
  description: `${name} does things`,
  version: "1.0.0",
  author: "Anthropic",
  homepage: null,
  category: null,
  tags: [],
  keywords: [],
  fetch: { kind: "github", repo: "anthropics/skills", ref: null, sha: null, path: name },
  availability: { kind: "available" },
  skills: [],
  ...extra,
});

const skill = (name: string, plugin: string, marketplace: string, extra: Partial<SkillListing> = {}): SkillListing => ({
  ref: `${plugin}:${name}`,
  name,
  plugin,
  marketplace,
  description: `${name} skill`,
  category: null,
  author: null,
  added: false,
  availability: { kind: "available" },
  ...extra,
});

const connector = (id: string, from: WorkspaceConnector["from"]): WorkspaceConnector => ({
  id,
  name: id.replace("con_", ""),
  title: id,
  url: "https://mcp.example.com/mcp",
  category: null,
  about: null,
  auth: "oauth",
  state: "connected",
  problem: null,
  from,
  tools: [],
  checked_at: null,
  header_name: null,
  signed_in_as: null,
  signed_in_at: "2026-10-10T12:00:00Z",
  grants: [],
  added_by: "ana",
  added_at: "2026-10-10T12:00:00Z",
});

test("the view and search live in the address, and Yours has a clean one", () => {
  assert.equal(readView(new URLSearchParams("")), "yours");
  assert.equal(readView(new URLSearchParams("view=discover")), "discover");
  assert.equal(readView(new URLSearchParams("view=nonsense")), "yours");
  assert.equal(readQuery(new URLSearchParams("q=+pdf+")), "pdf");
  assert.equal(withParams("/acme/-/customize/skills", new URLSearchParams("q=pdf"), { view: "discover" }), "/acme/-/customize/skills?q=pdf&view=discover");
  assert.equal(withParams("/acme/-/customize/skills", new URLSearchParams("view=discover&q=pdf"), { view: "yours", q: null }), "/acme/-/customize/skills");
  assert.equal(tabOf("/acme/-/customize/plugins"), "plugins");
  assert.equal(tabOf("/acme/-/customize/plugins.data"), "plugins");
  assert.equal(tabOf("/acme/-/customize/plugins/pdf%40anthropic-agent-skills"), null);
  assert.equal(tabOf("/acme/-/customize/requests"), null);
});

test("pages are under -/customize, with a plugin's ref encoded", () => {
  assert.equal(pluginPath("acme", "pdf@anthropic-agent-skills"), "/acme/-/customize/plugins/pdf%40anthropic-agent-skills");
  assert.equal(connectorPagePath("acme", "con_abc"), "/acme/-/customize/connectors/con_abc");
  assert.equal(connectorNewPath("acme"), "/acme/-/customize/connectors/new");
  assert.equal(connectorNewPath("acme", "notion"), "/acme/-/customize/connectors/new?directory=notion");
  assert.equal(connectorCallbackPath("acme"), "/acme/-/customize/connectors/callback");
});

test("Customize is part of Apps, and the Marketplace's addresses lead to it", () => {
  assert.equal(modeOf("/acme/-/customize", "acme"), "apps");
  assert.equal(modeOf("/acme/-/customize/plugins/pdf%40g1t", "acme"), "apps");
  assert.equal(workspaceRedirect("/acme/-/marketplace"), "/acme/-/customize");
  assert.equal(workspaceRedirect("/acme/-/marketplace/extensions"), "/acme/-/customize/plugins");
  assert.equal(workspaceRedirect("/acme/-/marketplace/extensions/mail"), "/acme/-/customize/plugins/mail%40g1t");
  assert.equal(workspaceRedirect("/acme/-/marketplace/integrations"), "/acme/-/customize/connectors");
  assert.equal(workspaceRedirect("/acme/-/marketplace/integrations/linear"), "/acme/-/customize/connectors?directory=linear");
  assert.equal(workspaceRedirect("/acme/-/marketplace/requests", "?x=1"), "/acme/-/customize/requests?x=1");
  assert.equal(workspaceRedirect("/acme/-/agents/skills"), "/acme/-/customize/skills?view=yours");
  assert.equal(workspaceRedirect("/acme/-/agents/skills.data", "?_routes=x&q=pdf"), "/acme/-/customize/skills?q=pdf&view=yours");
  assert.equal(workspaceRedirect("/acme/-/agents/skills/pdf"), null, "a skill's own page stays where it is");
  assert.equal(workspaceRedirect("/acme/-/customize/skills"), null);
});

test("requests name plugins, skills and connectors, and an owner adds each where it is added", () => {
  const views = connectorsFor("workspace");
  assert.equal(pluginListingRef(plugin("pdf", "anthropic-agent-skills")), "plugin:pdf@anthropic-agent-skills");
  assert.equal(skillListingRef(skill("pdf", "document-skills", "anthropic-agent-skills")), "skill:document-skills@anthropic-agent-skills/pdf");
  assert.equal(addPath(request("plugin:pdf@anthropic-agent-skills", "ana"), "acme", views), "/acme/-/customize/plugins/pdf%40anthropic-agent-skills");
  assert.equal(addPath(request("skill:document-skills@anthropic-agent-skills/pdf", "ana"), "acme", views), "/acme/-/customize/plugins/document-skills%40anthropic-agent-skills");
  assert.equal(addPath(request("connector:notion", "ana"), "acme", views), "/acme/-/customize/connectors/new?directory=notion");
  assert.equal(addPath(request("integration:jira", "ana"), "acme", views), "/acme/-/integrations/trackers?add=jira#add");
  assert.equal(addPath({ listing: "extension:mail" }, "acme", views), null, "extensions are g1t's own, announced");
  assert.equal(addPath({ listing: "nonsense" }, "acme", views), null);
  assert.equal(kindWord("skill"), "Skill");
  assert.equal(kindWord("integration"), "Integration");
});

test("who asked for what, and what is still waiting", () => {
  const requests = [request("plugin:pdf@m", "ana"), request("plugin:pdf@m", "bo"), request("plugin:xlsx@m", "ana", "done")];
  assert.equal(openRequests(requests).length, 2);
  assert.ok(requestedBy(requests, "plugin:pdf@m", "Ana"));
  assert.ok(!requestedBy(requests, "plugin:xlsx@m", "ana"), "answered is not waiting");
  assert.equal(waitingFor(requests, "plugin:pdf@m"), 2);
  assert.equal(waitingFor(requests, "plugin:none@m"), 0);
});

test("the requests forms are read strictly", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [k, v] of Object.entries(fields)) data.set(k, v);
    return data;
  };
  assert.deepEqual(customizeForm(form({ intent: "request", listing: "plugin:pdf@anthropic-agent-skills", note: "  for invoices  " })), { intent: "request", listing: "plugin:pdf@anthropic-agent-skills", note: "for invoices" });
  assert.deepEqual(customizeForm(form({ intent: "request", listing: "skill:a@m/b" })), { intent: "request", listing: "skill:a@m/b", note: null });
  assert.equal(customizeForm(form({ intent: "request", listing: "agent:qa" })), null);
  assert.deepEqual(customizeForm(form({ intent: "resolve", id: "ins_1", status: "declined" })), { intent: "resolve", id: "ins_1", status: "declined" });
  assert.equal(customizeForm(form({ intent: "resolve", id: "ins_1", status: "open" })), null);
  assert.equal(customizeForm(form({ intent: "install" })), null);
});

test("plugins are narrowed by what was typed, a category and a marketplace, and ordered by marketplace or name", () => {
  const listings = [
    plugin("xlsx", "anthropic-agent-skills", { category: "Documents" }),
    plugin("pdf", "anthropic-agent-skills", { category: "Documents", keywords: ["invoices"] }),
    plugin("linear", "claude-plugins-official", { category: "Productivity", author: "Linear" }),
    plugin("support", "g1t", { availability: { kind: "soon" } }),
  ];
  assert.deepEqual(categoriesOf(listings), ["Documents", "Productivity"]);
  assert.deepEqual(filterPlugins(listings, readPluginFilters(new URLSearchParams(""))).map((l) => l.ref), ["pdf@anthropic-agent-skills", "xlsx@anthropic-agent-skills", "linear@claude-plugins-official", "support@g1t"]);
  assert.deepEqual(filterPlugins(listings, readPluginFilters(new URLSearchParams("sort=name"))).map((l) => l.name), ["linear", "pdf", "support", "xlsx"]);
  assert.deepEqual(filterPlugins(listings, readPluginFilters(new URLSearchParams("category=Documents&q=invoice"))).map((l) => l.name), ["pdf"]);
  assert.deepEqual(filterPlugins(listings, readPluginFilters(new URLSearchParams("marketplace=g1t"))).map((l) => l.name), ["support"]);
  assert.deepEqual(filterPlugins(listings, readPluginFilters(new URLSearchParams("q=Linear"))).map((l) => l.name), ["linear"], "the author counts");
  assert.ok(matches(["Agents can read", "PostHog"], "post hog"));
  assert.ok(!matches(["PostHog"], "sentry"));
  assert.deepEqual(groupByMarketplace(filterPlugins(listings, readPluginFilters(new URLSearchParams("")))).map((g) => [g.marketplace, g.items.length]), [["anthropic-agent-skills", 2], ["claude-plugins-official", 1], ["g1t", 1]]);
});

test("skills in Discover are searched and filtered the same way", () => {
  const listings = [skill("pdf", "document-skills", "anthropic-agent-skills", { category: "Documents" }), skill("brand", "design", "anthropic-agent-skills", { category: "Design" }), skill("abc", "zzz", "other")];
  assert.deepEqual(filterSkills(listings, { q: "", category: null }).map((l) => l.name), ["abc", "brand", "pdf"]);
  assert.deepEqual(filterSkills(listings, { q: "document", category: null }).map((l) => l.name), ["pdf"]);
  assert.deepEqual(filterSkills(listings, { q: "", category: "Design" }).map((l) => l.name), ["brand"]);
});

test("a listing's availability and what a plugin brings read in a few words", () => {
  assert.deepEqual(availabilityWord({ kind: "available" }), { label: "Available", tone: "neutral" });
  assert.deepEqual(availabilityWord({ kind: "installed", enabled: true }), { label: "Installed", tone: "success" });
  assert.deepEqual(availabilityWord({ kind: "installed", enabled: false }), { label: "Switched off", tone: "warn" });
  assert.equal(availabilityWord({ kind: "unavailable", why: "npm" }).label, "Not available here");
  assert.equal(availabilityWord({ kind: "soon" }).label, "Soon");
  const components: PluginComponents = {
    skills: [{ name: "pdf", description: null, path: "skills/pdf" }],
    agents: [{ name: "reviewer", description: null, path: "agents/reviewer.md" }],
    commands: [{ name: "release", path: "commands/release.md" }],
    mcp_servers: [
      { name: "linear", type: "http", url: "https://mcp.linear.app/mcp", remote: true },
      { name: "fs", type: "stdio", url: null, remote: false },
    ],
    hooks: true,
    lsp: false,
    bin: true,
    output_styles: false,
  };
  assert.deepEqual(componentChips(components), ["2 skills", "1 agent", "1 connector"]);
  assert.deepEqual(claudeCodeOnly(components), ["hooks", "bin", "1 local MCP server"]);
  assert.deepEqual(componentChips({ ...components, skills: [], commands: [], agents: [], mcp_servers: [] }), []);
  assert.equal(fromWords({ kind: "plugin", ref: "linear@claude-plugins-official", server: "linear" }), "Brought by linear@claude-plugins-official");
  assert.equal(fromWords({ kind: "agent", handle: "margo" }), "Moved from @margo");
  assert.equal(fetchWords({ kind: "github", repo: "anthropics/skills", ref: null, sha: null, path: "skills/pdf" }), "github.com/anthropics/skills/skills/pdf");
  assert.equal(fetchWords({ kind: "g1t", repo: "acme/plugins", ref: "main", path: "" }), "acme/plugins on this g1t at main");
  assert.equal(fetchWords({ kind: "unsupported", why: "It is published on npm." }), "It is published on npm.");
});

test("the connectors directory puts MCP servers first, says which are connected, and keeps g1t's integrations apart", () => {
  const views = connectorsFor("workspace");
  const notion = connector("con_notion", { kind: "directory", id: "notion" });
  const directory = connectorsDirectory(views, [notion, connector("con_x", { kind: "address" })], { sentry: { detail: "acme", problem: null, manage: "/acme/-/integrations/alerts" } }, { github: "No GitHub App." }, "acme");
  assert.ok(directory.mcp.every((entry) => entry.view.mcp && entry.view.status === "available"));
  assert.equal(directory.mcp.at(-1)?.view.id, "notion", "the connected one comes last");
  assert.equal(directory.mcp.find((entry) => entry.view.id === "notion")?.connector?.id, "con_notion");
  assert.ok(directory.mcp.some((entry) => entry.view.mcp?.caveat), "a caveat the directory knows is kept");
  assert.equal(directory.integrations[0]?.view.id, "sentry");
  assert.equal(directory.integrations[0]?.href, "/acme/-/integrations/alerts");
  const github = directory.integrations.find((entry) => entry.view.id === "github")!;
  assert.equal(github.why, "No GitHub App.");
  assert.equal(github.href, null);
  assert.equal(directory.integrations.find((entry) => entry.view.id === "jira")?.href, "/acme/-/integrations/trackers?add=jira#add");
  assert.ok(directory.soon.some((view) => view.id === "slack"));
  assert.ok(!directory.integrations.some((entry) => entry.view.mcp));
  const searched = connectorsDirectory(views, [], {}, {}, "acme", "notion");
  assert.deepEqual(searched.mcp.map((entry) => entry.view.id), ["notion"]);
  assert.equal(searched.soon.length, 0);
  const personal = personalDirectory(connectorsFor("personal"));
  assert.ok(personal.some((view) => view.id === "mcp"));
  assert.ok(personal.every((view) => view.href));
});

test("where something reaches: the options, what is already given, and the line that says so", () => {
  const reach = [
    { id: "g1", scope: "team" as const, target: "qa", label: "QA" },
    { id: "g2", scope: "agent" as const, target: "Margo", label: "@margo" },
  ];
  const options = reachOptions(reach, { can_manage: true, teams: [{ slug: "qa", name: "QA" }], agents: [{ handle: "margo", display_name: "Margo" }, { handle: "otto", display_name: "Otto" }] });
  assert.deepEqual(options.map((o) => [o.value, o.checked]), [["workspace:", false], ["team:qa", true], ["agent:margo", true], ["agent:otto", false]]);
  assert.equal(options[1]!.reach?.id, "g1");
  const maintainer = reachOptions([], { can_manage: false, teams: [{ slug: "qa", name: "QA" }], agents: [{ handle: "margo", display_name: "Margo" }] });
  assert.deepEqual(maintainer.map((o) => o.value), ["team:qa"]);
  assert.deepEqual(splitTarget("workspace:"), { scope: "workspace", target: null });
  assert.deepEqual(splitTarget("team:qa"), { scope: "team", target: "qa" });
  assert.deepEqual(splitTarget("nonsense:x"), { scope: "workspace", target: "x" });
  assert.equal(reachWords([]), "no agent yet");
  assert.equal(reachWords([{ id: "g0", scope: "workspace", target: null, label: "Every agent" }, ...reach]), "Every agent");
  assert.equal(reachWords(reach), "QA and @margo");
  assert.equal(reachWords([...reach, { id: "g3", scope: "agent", target: "otto", label: "@otto" }]), "QA, @margo and 1 more");
});

test("a plugin's subagent starts the new-agent form", () => {
  const draft = pluginAgentDraft({ ref: "pr-review-toolkit:code-reviewer", plugin: "pr-review-toolkit", marketplace: "claude-plugins-official", name: "code-reviewer", description: "Reviews pull requests for bugs.", prompt: "You review code.", model: "opus", skills: [], tools: [] });
  assert.equal(draft.handle, "code-reviewer");
  assert.equal(draft.display_name, "Code Reviewer");
  assert.deepEqual(draft.responsibilities, ["Reviews pull requests for bugs."]);
  assert.equal(draft.instructions, "You review code.");
  assert.equal(draft.routing.floor, "frontier");
  assert.equal(pluginAgentDraft({ ref: "a:b", plugin: "a", marketplace: "m", name: "b", description: "", prompt: "", model: "haiku", skills: [], tools: [] }).routing.ceiling, "small");
  assert.equal(pluginAgentDraft({ ref: "a:b", plugin: "a", marketplace: "m", name: "b", description: "", prompt: "", model: null, skills: [], tools: [] }).routing.floor, null);
  assert.equal(titleOf("my_fine-agent"), "My Fine Agent");
});

test("typing a search or picking a filter reloads nothing; another page, view or a posted form does", () => {
  const at = (path: string) => new URL(`https://g1t.sh${path}`);
  assert.equal(needsReload(at("/acme/-/customize/plugins"), at("/acme/-/customize/plugins?q=pdf"), undefined), false);
  assert.equal(needsReload(at("/acme/-/customize/plugins?q=p"), at("/acme/-/customize/plugins?q=pd&category=Documents"), undefined), false);
  assert.equal(needsReload(at("/acme/-/customize/plugins"), at("/acme/-/customize/plugins?view=discover"), undefined), true);
  assert.equal(needsReload(at("/acme/-/customize/plugins"), at("/acme/-/customize/skills"), undefined), true);
  assert.equal(needsReload(at("/acme/-/customize/plugins"), at("/acme/-/customize/plugins"), "POST"), true);
  assert.equal(needsReload(at("/acme/-/customize/plugins"), at("/acme/-/customize/plugins"), "GET"), false);
});

test("a page's flash comes from its address", () => {
  assert.deepEqual(flashOf(new URLSearchParams("problem=The+server+refused")), { tone: "danger", text: "The server refused" });
  assert.equal(flashOf(new URLSearchParams("signed_in=1"))?.tone, "success");
  assert.equal(flashOf(new URLSearchParams("added=1"))?.tone, "success");
  assert.equal(flashOf(new URLSearchParams("")), null);
});
