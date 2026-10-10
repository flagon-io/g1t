import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentTeam, PresenceEntry } from "@g1t/contracts";

import { agentIdsOn, localTime, showing, teamBudgetBlock, teamsSection, whoToPage, type TeamsHere } from "./teammates.ts";

const NOW = new Date("2026-10-09T01:12:00Z");

const person = (username: string, extra: Partial<AgentTeam["people"][number]> = {}): AgentTeam["people"][number] => ({
  user_id: `usr_${username}`,
  username,
  name: null,
  title: null,
  timezone: null,
  owns: [],
  manager: null,
  maintainer: false,
  ...extra,
});

const entry = (username: string, presence: PresenceEntry["presence"], extra: Partial<PresenceEntry> = {}): PresenceEntry => ({
  user_id: `usr_${username}`,
  username,
  presence,
  dnd_until: null,
  status: null,
  at: 1,
  ...extra,
});

const sales: AgentTeam = {
  slug: "sales",
  name: "Sales",
  description: "Two people and one agent",
  lead: { kind: "user", username: "sofia", name: "Sofia Reyes", avatar: null },
  channel: { id: "chn_1", name: "sales" },
  budget_micros: 150_000_000,
  people: [
    person("sofia", { name: "Sofia Reyes", title: "Head of Sales", owns: ["the forecast"], manager: "chase", maintainer: true, timezone: "America/Chicago" }),
    person("jordan", { name: "Jordan Lee", title: "Account Executive", owns: ["Halcyon", "Bluebird"], manager: "sofia" }),
  ],
  agent_ids: ["agt_david"],
};

const here = (presence: PresenceEntry[]): TeamsHere => ({
  teams: [sales],
  agents: [
    { id: "agt_david", handle: "david", display_name: "David", title: "CRM keeper" },
    { id: "agt_pax", handle: "pax", display_name: "Pax", title: "Billing" },
  ],
  presence,
});

test("an agent is on the teams it was added to, and only those", () => {
  assert.deepEqual(agentIdsOn(sales), ["agt_david"]);
  assert.deepEqual(agentIdsOn({ ...sales, agent_ids: ["agt_pax", "agt_pax"] }), ["agt_pax"]);
  assert.deepEqual(agentIdsOn({ ...sales, agent_ids: [] }), []);
});

test("an agent is told who leads, who owns what and who is around", () => {
  const dnd = new Date(NOW.getTime() + 3 * 3600_000).toISOString();
  const text = teamsSection("agt_david", here([entry("sofia", "active", { dnd_until: dnd }), entry("jordan", "active")]), NOW)!;
  assert.match(text, /^## Your teams/);
  assert.match(text, /### Sales/);
  assert.match(text, /Led by Sofia Reyes \(@sofia\)\./);
  assert.match(text, /Its channel is #sales\./);
  assert.match(text, /share a budget of \$150\.00 a month/);
  assert.match(text, /Sofia Reyes \(@sofia\); Head of Sales, the lead, a maintainer; owns the forecast; reports to @chase \(focusing in Do Not Disturb until 23:12 their time; it's 20:12 for them\)/);
  assert.match(text, /Jordan Lee \(@jordan\); Account Executive; owns Halcyon, Bluebird; reports to @sofia \(online\)/);
  assert.match(text, /- @david: you/);
  // Sofia is focusing, so Jordan is the one to page.
  assert.match(text, /When a person is needed: Jordan Lee \(@jordan\), who is online now\./);
});

test("with no one reachable, the agent is told to post and wait", () => {
  const text = teamsSection("agt_david", here([entry("sofia", "away"), entry("jordan", "offline")]), NOW)!;
  assert.match(text, /No one on Sales can be reached now; post in #sales and say they'll see it when they're back\./);
});

test("without presence, nobody is said to be offline", () => {
  const text = teamsSection("agt_david", here([]), NOW)!;
  assert.doesNotMatch(text, /offline/);
  assert.doesNotMatch(text, /When a person is needed/);
});

test("an agent on no team is told nothing", () => {
  assert.equal(teamsSection("agt_david", { teams: [], agents: [], presence: [] }, NOW), null);
  assert.equal(teamsSection("agt_david", null, NOW), null);
});

test("who to page: the lead, then a maintainer, then anyone reachable", () => {
  const presence = new Map([entry("sofia", "active"), entry("jordan", "active")].map((e) => [e.user_id, e]));
  assert.equal(whoToPage(sales, presence, NOW, true)?.username, "sofia");
  presence.set("usr_sofia", entry("sofia", "away"));
  assert.equal(whoToPage(sales, presence, NOW, true)?.username, "jordan");
  assert.equal(whoToPage(sales, presence, NOW, false), null);
});

test("presence and local time read plainly", () => {
  assert.equal(showing(undefined, null, NOW, true), "offline");
  assert.equal(showing(entry("a", "away", { status: { emoji: "🌴", text: "On leave", clear_at: null, source: "manual", set_at: "" } }), null, NOW, true), 'away; status "🌴 On leave"');
  assert.equal(showing(entry("a", "active"), null, NOW, false), null);
  assert.equal(localTime("Europe/London", NOW), "02:12");
  assert.equal(localTime("Not/AZone", NOW), null);
});

test("a team's budget stops its agents once they have spent it together", () => {
  assert.equal(teamBudgetBlock([{ name: "Sales", budget_micros: 150_000_000, spent_micros: 149_000_000 }]), null);
  assert.match(teamBudgetBlock([{ name: "Sales", budget_micros: 150_000_000, spent_micros: 150_000_000 }])!, /^Sales's agents have used the team's budget of \$150\.00/);
});
