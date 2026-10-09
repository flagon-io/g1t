import assert from "node:assert/strict";
import { test } from "node:test";

import type { Contributors, Profile, ProfileWorkspace, RepoPath, Result, Viewer } from "@g1t/contracts";

import { type CardSources, buildCard, cardHref, committedLabel, committedWithin, parseRepo } from "./hovercard.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const DAY = 86_400_000;

const ada: Profile = {
  username: "ada",
  name: "Ada Lovelace",
  bio: "Engines.",
  location: "London",
  website: "https://ada.example",
  pronouns: "she/her",
  timezone: "Europe/London",
  avatar: "cafe",
  createdAt: "2026-01-01T00:00:00Z",
};

const me: Viewer = { id: "usr_me", username: "me", kind: "user", verified: true } as Viewer;

/**
 * Stand-ins for identity and repos that behave as they do: workspaces are
 * shown only when the viewer shares them, or when ada has a public project
 * there; the repository answers only viewers who may read it.
 */
function sources(over: Partial<CardSources> = {}): CardSources & { asked: { viewer: Viewer; publicIn: string[] }[] } {
  const asked: { viewer: Viewer; publicIn: string[] }[] = [];
  const memberships: ProfileWorkspace[] = [
    { slug: "acme", name: "Acme", avatar: null },
    { slug: "secret-lab", name: "Secret Lab", avatar: null },
  ];
  return {
    asked,
    profile: async (username) => (username === "ada" ? ada : null),
    accountId: async (username) => (username === "ada" ? "usr_ada" : null),
    publicNamespaces: async () => ["acme"],
    profileWorkspaces: async (_username, viewer, publicIn) => {
      asked.push({ viewer, publicIn });
      // secret-lab is private: only someone who belongs to it sees it.
      return memberships.filter((one) => publicIn.includes(one.slug) || (viewer?.username === "insider" && one.slug === "secret-lab"));
    },
    contributors: async (path: RepoPath, viewer: Viewer): Promise<Result<Contributors>> => {
      if (path.name === "private" && viewer?.username !== "insider") {
        return { ok: false, error: { code: "not_found", message: "Repository not found." } } as Result<Contributors>;
      }
      return {
        ok: true,
        value: {
          head: "h",
          commit: "h",
          computedAt: null,
          pending: false,
          partial: false,
          total: 1,
          commits: 3,
          weeks: [],
          contributors: [{ kind: "user", name: "ada", username: "ada", avatar: "cafe", commits: 3, firstAt: "2026-09-01T00:00:00Z", lastAt: new Date(NOW - 3 * DAY).toISOString(), weeks: [] }],
        },
      };
    },
    ...over,
  };
}

test("the card is the public profile, signed out too", async () => {
  const card = await buildCard("Ada", null, null, sources(), NOW);
  assert.ok(card && card.kind === "user");
  assert.equal(card.username, "ada");
  assert.equal(card.name, "Ada Lovelace");
  assert.equal(card.pronouns, "she/her");
  assert.equal(card.bio, "Engines.");
  assert.equal(card.location, "London");
  assert.equal(card.avatar, "cafe");
  assert.equal(card.committed, null, "no repository, nothing about commits");
  // Never an address.
  assert.ok(!JSON.stringify(card).includes("@"));
});

test("a private workspace is hidden from someone outside it", async () => {
  const outside = sources();
  const outsider = await buildCard("ada", me, null, outside, NOW);
  assert.deepEqual(outsider?.kind === "user" && outsider.workspaces.map((one) => one.slug), ["acme"]);
  // The viewer is passed through, for identity to decide.
  assert.equal(outside.asked[0]!.viewer, me);
  assert.deepEqual(outside.asked[0]!.publicIn, ["acme"]);
  const insider = await buildCard("ada", { ...me, username: "insider" } as Viewer, null, sources(), NOW);
  assert.deepEqual(insider?.kind === "user" && insider.workspaces.map((one) => one.slug), ["acme", "secret-lab"]);
});

test("commits to a repository show only to those who may read it", async () => {
  const open = await buildCard("ada", null, { namespace: "acme", name: "web" }, sources(), NOW);
  assert.equal(open?.kind === "user" && open.committed, "week");
  const hidden = await buildCard("ada", me, { namespace: "acme", name: "private" }, sources(), NOW);
  assert.equal(hidden?.kind === "user" && hidden.committed, null);
});

test("the card carries the time zone a profile gives, and none when it gives none", async () => {
  const card = await buildCard("ada", me, null, sources(), NOW);
  assert.equal(card?.kind === "user" && card.timezone, "Europe/London");
  const without = await buildCard("ada", me, null, sources({ profile: async () => ({ ...ada, timezone: null }) }), NOW);
  assert.equal(without?.kind === "user" && without.timezone, null);
});

test("a failing service leaves its part out, not the card", async () => {
  const card = await buildCard(
    "ada",
    me,
    { namespace: "acme", name: "web" },
    sources({ profileWorkspaces: async () => Promise.reject(new Error("down")), contributors: async () => Promise.reject(new Error("down")) }),
    NOW,
  );
  assert.ok(card && card.kind === "user");
  assert.deepEqual(card.workspaces, []);
  assert.equal(card.committed, null);
});

test("g1t has its own card; ghost and strangers have none", async () => {
  assert.deepEqual(await buildCard("g1t", null, null, sources(), NOW), { kind: "g1t", username: "g1t" });
  assert.equal(await buildCard("ghost", me, null, sources(), NOW), null);
  assert.equal(await buildCard("nobody", me, null, sources(), NOW), null);
  assert.equal(await buildCard("../etc", me, null, sources(), NOW), null);
});

test("workspaces past three are counted", async () => {
  const many = Array.from({ length: 5 }, (_, index) => ({ slug: `w${index}`, name: `W${index}`, avatar: null }));
  const card = await buildCard("ada", me, null, sources({ profileWorkspaces: async () => many }), NOW);
  assert.ok(card && card.kind === "user");
  assert.equal(card.workspaces.length, 3);
  assert.equal(card.more_workspaces, 2);
});

test("how recently, in the words the card uses", () => {
  assert.equal(committedWithin(new Date(NOW - 2 * 3_600_000).toISOString(), NOW), "day");
  assert.equal(committedWithin(new Date(NOW - 6 * DAY).toISOString(), NOW), "week");
  assert.equal(committedWithin(new Date(NOW - 20 * DAY).toISOString(), NOW), "month");
  assert.equal(committedWithin(new Date(NOW - 60 * DAY).toISOString(), NOW), null);
  assert.equal(committedWithin(null, NOW), null);
  assert.equal(committedLabel("week"), "Committed to this repository in the past week");
});

test("the card's address and its repository", () => {
  assert.equal(cardHref("Ada", "acme/web"), "/-/hovercard/user/ada?repo=acme%2Fweb");
  assert.equal(cardHref("ada", null), "/-/hovercard/user/ada");
  assert.deepEqual(parseRepo("acme/web"), { namespace: "acme", name: "web" });
  assert.equal(parseRepo("acme"), null);
  assert.equal(parseRepo("../x/y"), null);
});
