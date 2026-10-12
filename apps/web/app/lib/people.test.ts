import assert from "node:assert/strict";
import { test } from "node:test";

import type { DirectoryPerson, DirectoryTeam, PeopleDirectory } from "@g1t/contracts";

import {
  type PeopleAgent,
  NO_TEAM,
  agentPath,
  agentsOn,
  groupByTeam,
  teamsByAgent,
  budgetFromText,
  codeAccessWords,
  directoryEntries,
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
    person("sofia", { name: "Sofia Reyes", title: "Head of Sales", owns: ["the forecast"] }),
    person("jordan", { name: "Jordan Lee", title: "Account Executive", owns: ["Halcyon", "Bluebird"] }),
    person("kai", { name: "Kai Nakamura", title: "Product Designer" }),
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

test("the directory lists people only, in one search; agents are never in it", () => {
  const names = (query: string) => directoryEntries(directory, query).map((e) => e.person.username);
  assert.deepEqual(names(""), ["chase", "sofia", "jordan", "kai"]);
  assert.deepEqual(names("sales"), ["sofia", "jordan"]);
  assert.deepEqual(names("halcyon"), ["jordan"]);
  assert.deepEqual(names("owner"), ["chase"]);
  // What only an agent would match (its handle, title or responsibilities) finds no one here.
  assert.deepEqual(names("david"), []);
  assert.deepEqual(names("errors"), []);
  // A team of agents only is no one's team in the directory.
  assert.deepEqual(names("night shift"), []);
  assert.equal(names("nobody here").length, 0);
  // Every entry is a person with their teams; nothing in the shape says "agent".
  const sofia = directoryEntries(directory, "sofia")[0]!;
  assert.deepEqual(Object.keys(sofia), ["person", "teams"]);
  assert.deepEqual(sofia.teams.map((t) => t.slug), ["sales"]);
});

test("an agent's profile is its page in Agents, where People links to it", () => {
  assert.equal(agentPath("acme", "margo"), "/acme/-/agents/margo");
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
