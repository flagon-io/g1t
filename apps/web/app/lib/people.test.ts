import assert from "node:assert/strict";
import { test } from "node:test";

import type { DirectoryPerson, DirectoryTeam, PeopleDirectory } from "@g1t/contracts";

import { codeAccessWords, directoryEntries, leads, ownsFromText } from "./people.ts";

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
  people: [],
  repos_count: 0,
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
      repos_count: 0,
    }),
    team("design", "Design", { people: [{ username: "kai", role: "maintainer" }], repos_count: 2 }),
    team("night-shift", "Night shift", { lead: { kind: "agent", agent_id: "agt_atlas" } }),
  ],
  base_permission: "read",
  can_manage: true,
};

test("a team's lead is a person; an old agent lead is nobody's", () => {
  assert.equal(leads(directory.teams[0]!.lead, { username: "sofia" }), true);
  assert.equal(leads(directory.teams[0]!.lead, { username: "jordan" }), false);
  assert.equal(leads(directory.teams[2]!.lead, { username: "atlas" }), false);
  assert.equal(leads(null, { username: "sofia" }), false);
});

test("the directory lists people, in one search", () => {
  const names = (query: string) => directoryEntries(directory, query).map((e) => e.person.username);
  assert.deepEqual(names(""), ["chase", "sofia", "jordan", "kai"]);
  assert.deepEqual(names("sales"), ["sofia", "jordan"]);
  assert.deepEqual(names("halcyon"), ["jordan"]);
  assert.deepEqual(names("owner"), ["chase"]);
  // A team with no people on it is no one's team in the directory.
  assert.deepEqual(names("night shift"), []);
  assert.equal(names("nobody here").length, 0);
  // Every entry is a person with their teams.
  const sofia = directoryEntries(directory, "sofia")[0]!;
  assert.deepEqual(Object.keys(sofia), ["person", "teams"]);
  assert.deepEqual(
    sofia.teams.map((t) => t.slug),
    ["sales"],
  );
});

test("forms read plainly", () => {
  assert.deepEqual(ownsFromText("storefront\n the release process ,, billing"), ["storefront", "the release process", "billing"]);
});

test("access to Code says where it comes from", () => {
  assert.equal(codeAccessWords({ role: "owner" }, "read", []).summary, "Admin on every repository, as an owner");
  const kai = codeAccessWords({ role: "member" }, "read", [directory.teams[1]!]);
  assert.equal(kai.summary, "Read on every repository, the workspace's base permission");
  assert.deepEqual(kai.through, ["Roles on 2 repositories through Design"]);
  assert.equal(codeAccessWords({ role: "member" }, "none", []).summary, "Only repositories they're given a role on");
});
