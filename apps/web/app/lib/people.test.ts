import assert from "node:assert/strict";
import { test } from "node:test";

import type { DirectoryPerson, DirectoryTeam, PeopleDirectory } from "@g1t/contracts";

import {
  type PeopleAgent,
  NO_TEAM,
  agentsOn,
  groupByTeam,
  teamsByAgent,
  budgetFromText,
  codeAccessWords,
  directoryEntries,
  managerChoices,
  orgChart,
  ownsFromText,
  teamBlock,
  teamsOfAgent,
} from "./people.ts";

const person = (username: string, extra: Partial<DirectoryPerson> = {}): DirectoryPerson => ({
  user_id: `usr_${username}`,
  username,
  name: null,
  avatar: null,
  bio: null,
  location: null,
  pronouns: null,
  timezone: null,
  role: "member",
  title: null,
  manager: null,
  owns: [],
  joined_at: "2026-10-01T00:00:00Z",
  ...extra,
});

const team = (slug: string, name: string, extra: Partial<DirectoryTeam> = {}): DirectoryTeam => ({
  slug,
  name,
  description: null,
  visibility: "visible",
  parent: null,
  lead: null,
  channel: null,
  budget_micros: null,
  people: [],
  agent_ids: [],
  repos_count: 0,
  ...extra,
});

const agent = (id: string, handle: string, extra: Partial<PeopleAgent> = {}): PeopleAgent => ({
  id,
  handle,
  display_name: handle[0]!.toUpperCase() + handle.slice(1),
  avatar: null,
  avatar_seed: handle,
  title: "",
  role: "",
  status: "idle",
  responsibilities: [],
  builtin: false,
  spent_month_micros: 0,
  ...extra,
});

const directory: PeopleDirectory = {
  people: [
    person("chase", { name: "Chase Pierce", title: "Founder", role: "owner" }),
    person("sofia", { name: "Sofia Reyes", title: "Head of Sales", manager: "chase", owns: ["the forecast"] }),
    person("jordan", { name: "Jordan Lee", title: "Account Executive", manager: "sofia", owns: ["Halcyon", "Bluebird"] }),
    person("kai", { name: "Kai Nakamura", title: "Product Designer", manager: "chase" }),
  ],
  teams: [
    team("sales", "Sales", {
      lead: { kind: "user", username: "sofia", name: "Sofia Reyes", avatar: null },
      people: [
        { username: "sofia", role: "maintainer" },
        { username: "jordan", role: "member" },
      ],
      agent_ids: ["agt_david"],
      repos_count: 0,
    }),
    team("design", "Design", { people: [{ username: "kai", role: "maintainer" }], repos_count: 2 }),
    team("night-shift", "Night shift", { lead: { kind: "agent", agent_id: "agt_atlas" }, agent_ids: ["agt_atlas", "agt_sentinel", "agt_david"] }),
  ],
  base_permission: "read",
  can_manage: true,
};

const agents = [
  agent("agt_david", "david", { title: "CRM keeper" }),
  agent("agt_atlas", "atlas", { title: "Night watch" }),
  agent("agt_sentinel", "sentinel", { title: "Error watch", responsibilities: ["Watches errors"] }),
  agent("agt_pax", "pax", { title: "Billing" }),
];

test("an agent is on the teams it is a member of, like anyone", () => {
  assert.deepEqual(agentsOn(directory.teams[2]!, agents).map((a) => a.id), ["agt_atlas", "agt_sentinel", "agt_david"]);
  assert.deepEqual(teamsOfAgent(directory.teams, agents[0]!).map((t) => t.slug), ["sales", "night-shift"]);
  assert.deepEqual(teamsOfAgent(directory.teams, agents[3]!), []);
});

test("the Agents sidebar groups agents by their teams: under each team, and the rest last", () => {
  const teams = teamsByAgent(directory.teams);
  assert.deepEqual(teams.agt_david, [{ slug: "night-shift", name: "Night shift" }, { slug: "sales", name: "Sales" }]);
  const groups = groupByTeam(agents, teams).map((g) => [g.label, g.agents.map((a) => a.handle)]);
  assert.deepEqual(groups, [
    ["Night shift", ["atlas", "david", "sentinel"]],
    ["Sales", ["david"]],
    [NO_TEAM, ["pax"]],
  ]);
  assert.deepEqual(groupByTeam(agents.slice(3), {}).map((g) => g.label), [NO_TEAM]);
});

test("the directory finds people and agents in one search", () => {
  const names = (query: string, kind: "everyone" | "people" | "agents" = "everyone") =>
    directoryEntries(directory, agents, query, kind).map((e) => (e.kind === "person" ? e.person.username : `@${e.agent.handle}`));
  assert.deepEqual(names("sales"), ["sofia", "jordan", "@david"]);
  assert.deepEqual(names("halcyon"), ["jordan"]);
  assert.deepEqual(names("errors"), ["@sentinel"]);
  assert.deepEqual(names("", "agents"), ["@david", "@atlas", "@sentinel", "@pax"]);
  assert.deepEqual(names("night"), ["@david", "@atlas", "@sentinel"]);
  assert.equal(names("nobody here").length, 0);
});

test("the org chart follows reporting lines, with each team's agents beside its lead", () => {
  const chart = orgChart(directory, agents);
  assert.deepEqual(chart.roots.map((n) => n.person.username), ["chase"]);
  const chase = chart.roots[0]!;
  assert.deepEqual(chase.reports.map((n) => n.person.username), ["sofia", "kai"]);
  const sofia = chase.reports[0]!;
  assert.deepEqual(sofia.agents.map((a) => a.handle), ["david"]);
  assert.deepEqual(sofia.reports.map((n) => n.person.username), ["jordan"]);
  // A team an agent leads sits apart, with its agents.
  assert.deepEqual(chart.unled.map((u) => [u.team.slug, u.agents.map((a) => a.handle)]), [["night-shift", ["atlas", "sentinel", "david"]]]);
});

test("no one goes missing from the org chart, even in a loop", () => {
  const looped: PeopleDirectory = { ...directory, people: [person("a", { manager: "b" }), person("b", { manager: "a" })] };
  const chart = orgChart(looped, []);
  const all = (nodes: typeof chart.roots): string[] => nodes.flatMap((n) => [n.person.username, ...all(n.reports)]);
  assert.deepEqual(all(chart.roots).sort(), ["a", "b"]);
});

test("someone can report to anyone but themselves and the people under them", () => {
  assert.deepEqual(managerChoices(directory.people, "sofia").map((p) => p.username), ["chase", "kai"]);
  assert.deepEqual(managerChoices(directory.people, "jordan").map((p) => p.username), ["chase", "sofia", "kai"]);
});

test("forms read plainly", () => {
  assert.deepEqual(ownsFromText("storefront\n the release process ,, billing"), ["storefront", "the release process", "billing"]);
  assert.equal(budgetFromText(""), 0);
  assert.equal(budgetFromText("$150"), 150_000_000);
  assert.equal(budgetFromText("1,250.50"), 1_250_500_000);
  assert.equal(budgetFromText("lots"), null);
  assert.equal(budgetFromText("-5"), null);
});

test("access to Code says where it comes from", () => {
  assert.equal(codeAccessWords({ role: "owner" }, "read", []).summary, "Admin on every repository, as an owner");
  const kai = codeAccessWords({ role: "member" }, "read", [directory.teams[1]!]);
  assert.equal(kai.summary, "Read on every repository, the workspace's base permission");
  assert.deepEqual(kai.through, ["Roles on 2 repositories through Design"]);
  assert.equal(codeAccessWords({ role: "member" }, "none", []).summary, "Only repositories they're given a role on");
});

test("a team's part of what an agent is told", () => {
  const told = "## Your teams\n\nIntro.\n\n### Sales\n\nLed by Sofia.\n- @sofia\n\n### Support\n\n- @dev";
  assert.equal(teamBlock(told, "Sales"), "### Sales\n\nLed by Sofia.\n- @sofia");
  assert.equal(teamBlock(told, "Support"), "### Support\n\n- @dev");
  assert.equal(teamBlock(told, "Design"), null);
  assert.equal(teamBlock(null, "Sales"), null);
});
