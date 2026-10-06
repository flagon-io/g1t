import assert from "node:assert/strict";
import { test } from "node:test";

import type { Issue, Project, Pull, Repo, Result, Workspace } from "@g1t/contracts";

import { RENDER_VERSION, cacheKey } from "./cache.ts";
import { type Sources, clean, docsCard, resolve, segments } from "./resolve.ts";

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const notFound: Result<never> = { ok: false, error: { code: "not_found", message: "Not found" } };
const author = { id: "u1", username: "ada" };

function repo(namespace: string, name: string, isPrivate = false): Repo {
  return {
    id: `${namespace}/${name}`,
    namespace,
    name,
    description: `About ${name}`,
    isPrivate,
    ownerId: "w",
    defaultBranch: "main",
    forkOf: null,
    protected: true,
    createdAt: "",
    topics: [],
  };
}

const REPOS: Record<string, Repo> = {
  "acme/web": repo("acme", "web"),
  "acme/vault": repo("acme", "vault", true),
};

const ISSUE = { number: 7, title: "Fix the thing", state: "closed", reason: "not_planned", author, requestedBy: null } as Issue;
// A change g1t made for ada.
const PULL = { number: 8, title: "Make the thing", status: "merged", author: { id: "usr_g1t_agent", username: "g1t", kind: "agent" }, requestedBy: author } as Pull;

/** Services that see what an anonymous visitor sees, and record that they were asked as one. */
function sources(overrides: Partial<Sources> = {}) {
  const viewers: unknown[] = [];
  const seen = <T>(viewer: unknown, value: T): T => {
    viewers.push(viewer);
    return value;
  };
  const hidden = (path: { namespace: string; name: string }) => {
    const found = REPOS[`${path.namespace}/${path.name}`.toLowerCase()];
    return !found || found.isPrivate;
  };
  const base: Sources = {
    identity: {
      getWorkspace: async (slug) =>
        slug === "acme" ? ({ slug: "acme", name: "Acme", description: "Rockets", id: "w", createdAt: "", memberCount: 3, avatar: null } as Workspace) : null,
      profile: async (username) =>
        username === "ada"
          ? { username: "ada", name: "Ada Lovelace", bio: "Engines.", location: null, website: null, pronouns: null, avatar: null, createdAt: "" }
          : null,
    },
    repos: {
      // Like the service: a private repository can come back to a member,
      // so the resolver must check `isPrivate` itself as well.
      get: async (path, viewer) => seen(viewer, REPOS[`${path.namespace}/${path.name}`.toLowerCase()] ? ok(REPOS[`${path.namespace}/${path.name}`.toLowerCase()]) : notFound),
    },
    work: {
      counts: async (path, viewer) => seen(viewer, hidden(path) ? notFound : ok({ issues: 3, pulls: 2 })),
      getIssue: async (path, number, viewer) =>
        seen(viewer, !hidden(path) && number === 7 ? ok({ issue: ISSUE, pulls: [], comments: [] }) : notFound),
      getPull: async (path, number, viewer) =>
        seen(viewer, !hidden(path) && number === 8 ? ok({ pull: PULL, issue: null, comments: [] } as never) : notFound),
      byAuthor: async (_username, viewer) =>
        seen(viewer, ok({ items: [], next: null, repos: [], counts: { pullsMerged: 4, pullsOpen: 1, pulls: 6, issues: 2, issuesOpen: 1 } })),
    },
    projects: {
      get: async (workspace, slug, viewer) =>
        seen(viewer, workspace === "acme" && slug === "web" ? ok({ name: "Web app", description: "The storefront", private: false } as Project) : notFound),
      list: async (workspace, viewer) =>
        seen(viewer, ok([{ private: false }, { private: false }, { private: true }] as Project[])),
    },
  };
  return { sources: { ...base, ...overrides }, viewers };
}

test("paths are split and decoded, and anything else is refused", () => {
  assert.deepEqual(segments("/acme/web/pull/8"), ["acme", "web", "pull", "8"]);
  assert.deepEqual(segments("/acme/web?tab=code#top"), ["acme", "web"]);
  assert.deepEqual(segments("/"), []);
  assert.equal(segments("https://evil.example/x"), null);
  assert.equal(segments("//evil.example/x"), null);
  assert.equal(segments("/%E0%A4%A"), null);
});

test("the site's own pages get their own cards, or the brand card", async () => {
  const { sources: s } = sources();
  assert.equal((await resolve("/", s)).kind, "brand");
  const pricing = await resolve("/pricing", s);
  assert.equal(pricing.kind, "page");
  assert.equal(pricing.kind === "page" && pricing.title, "What it costs us, plus a markup");
  assert.equal((await resolve("/explore", s)).kind, "page");
  assert.equal((await resolve("/login", s)).kind, "brand");
  assert.equal((await resolve("/settings/keys", s)).kind, "brand");
  const privacy = await resolve("/policies/privacy", s);
  assert.equal(privacy.kind === "page" && privacy.title, "Privacy Policy");
  assert.equal((await resolve("/status", s)).kind, "page");
  assert.equal((await resolve("/security", s)).kind, "page");
  assert.equal((await resolve("/policies/nothing", s)).kind, "brand");
});

test("a workspace shows its name and how many projects are public", async () => {
  const { sources: s } = sources();
  assert.deepEqual(await resolve("/acme", s), {
    kind: "workspace",
    slug: "acme",
    name: "Acme",
    description: "Rockets",
    projects: 2,
    avatar: null,
  });
  // Its members-only pages show the same public card.
  assert.equal((await resolve("/acme/-/billing", s)).kind, "workspace");
  assert.equal((await resolve("/nobody", s)).kind, "brand");
});

test("a person shows their name, bio and public work, looked up as no one", async () => {
  const { sources: s, viewers } = sources();
  assert.deepEqual(await resolve("/u/Ada", s), {
    kind: "person",
    username: "ada",
    name: "Ada Lovelace",
    bio: "Engines.",
    pullsMerged: 4,
    pullsOpen: 1,
    issues: 2,
    avatar: null,
  });
  assert.ok(viewers.every((viewer) => viewer === null));
  assert.equal((await resolve("/u/nobody", s)).kind, "brand");
  assert.equal((await resolve("/u", s)).kind, "brand");
  assert.equal((await resolve("/u/ada/extra", s)).kind, "brand");
});

test("a public project shows its name, description and open work", async () => {
  const { sources: s } = sources();
  assert.deepEqual(await resolve("/acme/web/commits", s), {
    kind: "project",
    owner: "acme",
    repo: "web",
    name: "Web app",
    description: "The storefront",
    issues: 3,
    pulls: 2,
  });
});

test("issues, pull requests and Soon pages get cards of their own", async () => {
  const { sources: s } = sources();
  assert.deepEqual(await resolve("/acme/web/issues/7", s), {
    kind: "issue",
    owner: "acme",
    repo: "web",
    number: 7,
    title: "Fix the thing",
    state: "not_planned",
    author: "ada",
    requestedBy: null,
  });
  const pull = await resolve("/acme/web/pull/8", s);
  assert.equal(pull.kind, "pull");
  assert.equal(pull.kind === "pull" && pull.state, "merged");
  // g1t made it, for ada: the card says both.
  assert.equal(pull.kind === "pull" && pull.author, "g1t");
  assert.equal(pull.kind === "pull" && pull.requestedBy, "ada");
  const soon = await resolve("/acme/web/soon/board", s);
  assert.equal(soon.kind, "soon");
  assert.equal(soon.kind === "soon" && soon.title, "Board");
  // One that does not exist falls back to the project.
  assert.equal((await resolve("/acme/web/issues/99", s)).kind, "project");
  assert.equal((await resolve("/acme/web/soon/nothing", s)).kind, "project");
  assert.equal((await resolve("/acme/web/issues/007x", s)).kind, "project");
});

test("nothing private ever reaches a card", async () => {
  const { sources: s } = sources();
  for (const path of ["/acme/vault", "/acme/vault/issues/7", "/acme/vault/pull/8", "/acme/vault/soon/board", "/acme/vault/settings"]) {
    assert.deepEqual(await resolve(path, s), { kind: "brand" }, path);
  }
  // A missing repository says nothing either.
  assert.deepEqual(await resolve("/acme/ghost/pull/8", s), { kind: "brand" });
});

test("a private project on a public repository keeps its name to itself", async () => {
  const { sources: s } = sources({
    projects: {
      get: async () => ok({ name: "Secret name", description: "Secret plans", private: true } as Project),
      list: async () => ok([]),
    },
  });
  const card = await resolve("/acme/web", s);
  assert.equal(card.kind === "project" && card.name, "web");
  assert.equal(card.kind === "project" && card.description, "About web");
});

test("every lookup is made with no viewer", async () => {
  const { sources: s, viewers } = sources();
  for (const path of ["/acme", "/acme/web", "/acme/web/issues/7", "/acme/web/pull/8", "/acme/vault/pull/8"]) {
    await resolve(path, s);
  }
  assert.ok(viewers.length > 0);
  assert.ok(viewers.every((viewer) => viewer === null));
});

test("a service that fails gives the brand card, marked so it is not kept", async () => {
  const { sources: s } = sources({
    repos: {
      get: async () => {
        throw new Error("down");
      },
    },
  });
  assert.deepEqual(await resolve("/acme/web", s), { kind: "brand", failed: true });
});

test("a docs card is bounded, and has a title even without one", () => {
  const card = docsCard(new URLSearchParams({ title: "  Quick\nstart ", section: "Get started", description: "x".repeat(400) }));
  assert.equal(card.kind === "docs" && card.title, "Quick start");
  assert.equal(card.kind === "docs" && card.description?.length, 300);
  assert.equal(docsCard(new URLSearchParams()).kind === "docs" && docsCard(new URLSearchParams()).title, "g1t docs");
  assert.equal(clean("   ", 10), null);
});

test("the cache key keeps only what changes the card", () => {
  const a = cacheKey(new URL("https://og.g1t.sh/image?utm=1&path=/acme/web&v=3"));
  const b = cacheKey(new URL("https://og.g1t.sh/image?path=/acme/web&v=3&x=2"));
  assert.equal(a, b);
  assert.notEqual(a, cacheKey(new URL("https://og.g1t.sh/image?path=/acme/web&v=4")));
  assert.match(a, new RegExp(`render=${RENDER_VERSION}`));
  // The keys cards were kept under before the render version was.
  assert.notEqual(a, "https://og.g1t.sh/image?design=1&path=%2Facme%2Fweb&v=3");
  const docs = cacheKey(new URL("https://og.g1t.sh/docs?title=Quickstart&v=2&utm=x"));
  assert.equal(docs, `https://og.g1t.sh/docs?render=${RENDER_VERSION}&title=Quickstart&v=2`);
});
