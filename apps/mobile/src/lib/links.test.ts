import assert from "node:assert/strict";
import { test } from "node:test";

import { linkPathOf, refContext, refRoute, refSitePath, routeFor, sessionRoute, sitePathOf, targetRoute } from "./links.ts";

test("a g1t:// link names a site path, as on the desktop", () => {
  assert.equal(sitePathOf("g1t://acme/-/chat/dm/chn_1"), "/acme/-/chat/dm/chn_1");
  assert.equal(sitePathOf("g1t:///acme/rocket/pull/3?tab=files"), "/acme/rocket/pull/3?tab=files");
  assert.equal(sitePathOf("https://g1t.sh/acme"), null);
});

test("an https link to the site names the same path as a g1t:// one", () => {
  assert.equal(linkPathOf("https://g1t.sh/acme/-/work/12"), "/acme/-/work/12");
  assert.equal(linkPathOf("g1t://acme/-/work/12"), "/acme/-/work/12");
  assert.equal(linkPathOf("https://g1t.sh/acme/-/work?repo=web#top"), "/acme/-/work?repo=web");
  assert.equal(linkPathOf("https://g1t.sh"), "/");
  assert.equal(linkPathOf("mailto:someone@example.com"), null);
});

test("Chat's pages open the app's Chat", () => {
  assert.equal(routeFor("/acme/-/chat"), "/chat?workspace=acme");
  assert.equal(routeFor("/acme/-/chat/general"), "/chat/general?workspace=acme");
  assert.equal(routeFor("/acme/-/chat/dm/chn_1"), "/chat/chn_1?workspace=acme");
  assert.equal(routeFor("/acme/-/chat/browse"), null);
});

test("Work's pages open the app's Work", () => {
  assert.equal(routeFor("/acme/-/work"), "/work?workspace=acme");
  assert.equal(routeFor("/acme/-/work/12"), "/work/12?workspace=acme");
  assert.equal(routeFor(linkPathOf("g1t://acme/-/work/12")!), "/work/12?workspace=acme");
  assert.equal(routeFor(linkPathOf("https://g1t.sh/acme/-/work/12")!), "/work/12?workspace=acme");
  assert.equal(routeFor("/acme/-/work/new"), "/work/new?workspace=acme");
  // The list keeps the filters the site's does, and drops anything else.
  assert.equal(routeFor("/acme/-/work?repo=web&label=bug&page=3"), "/work?workspace=acme&label=bug&repo=web");
  assert.equal(routeFor("/acme/-/work/labels"), null);
  assert.equal(routeFor("/acme/-/work/milestones/2"), null);
  assert.equal(routeFor("/acme/-/work/12/edit"), null);
});

test("Work's board opens Work on its board", () => {
  assert.equal(routeFor("/acme/-/work/board"), "/work?workspace=acme&view=board");
  assert.equal(routeFor(linkPathOf("g1t://acme/-/work/board")!), "/work?workspace=acme&view=board");
  assert.equal(routeFor("/acme/-/work/board/x"), null);
});

test("Work's sessions open Work on its Sessions, and a session its screen", () => {
  assert.equal(routeFor(linkPathOf("g1t://acme/-/work/sessions")!), "/work?workspace=acme&view=sessions");
  assert.equal(routeFor(linkPathOf("https://g1t.sh/acme/-/work/sessions")!), "/work?workspace=acme&view=sessions");
  assert.equal(routeFor(linkPathOf("g1t://acme/-/work/sessions/ses_01abc")!), "/work/sessions/ses_01abc?workspace=acme");
  assert.equal(routeFor(linkPathOf("https://g1t.sh/acme/-/work/sessions/ses_01abc")!), "/work/sessions/ses_01abc?workspace=acme");
  // The list keeps the filters the site's does, and drops anything else.
  assert.equal(routeFor("/acme/-/work/sessions?state=live&repo=web&page=2"), "/work?workspace=acme&view=sessions&state=live&repo=web");
  assert.equal(routeFor("/acme/-/work/sessions/ses_1/entries"), null);
  // Chat's sessions, where the site has them now.
  assert.equal(routeFor(linkPathOf("https://g1t.sh/acme/-/chat/sessions")!), "/work?workspace=acme&view=sessions");
  assert.equal(routeFor(linkPathOf("https://g1t.sh/acme/-/chat/sessions/ses_01abc")!), "/work/sessions/ses_01abc?workspace=acme");
  // Sessions were once a page of their own; that address is gone, so the app has no screen for it.
  assert.equal(routeFor("/acme/-/sessions"), null);
  assert.equal(routeFor("/acme/-/sessions/ses_1"), null);
});

test("a session opens its page, or its pull request's for g1t's agent and a recorded one", () => {
  assert.equal(sessionRoute({ kind: "harness", id: "ses_1", repo: "acme/web", pull: 3 }, "acme", true), "/work/sessions/ses_1?workspace=acme");
  assert.equal(sessionRoute({ kind: "hosted", id: "ses_2", repo: "acme/web", pull: null }, "acme", false), "/work/sessions/ses_2?workspace=acme");
  assert.equal(sessionRoute({ kind: "agent", id: "run_1", repo: "acme/web", pull: 3 }, "acme", true), "/code/acme/web/pull/3");
  assert.equal(sessionRoute({ kind: "recorded", id: "pr_1", repo: "acme/web", pull: 3 }, "acme", false), "/open?path=%2Facme%2Fweb%2Fpull%2F3%2Fsession");
  assert.equal(sessionRoute({ kind: "recorded", id: "pr_1", repo: "acme/web", pull: null }, "acme", true), null);
});

test("an old link to an issue asks g1t what its number names in its repository", () => {
  assert.equal(routeFor("/acme/rocket/issues/12"), "/ref?repo=acme%2Frocket&number=12");
  assert.equal(routeFor(linkPathOf("https://g1t.sh/acme/rocket/issues/12")!), "/ref?repo=acme%2Frocket&number=12");
  assert.equal(routeFor("/acme/rocket/issues"), "/work?workspace=acme&repo=rocket");
  assert.equal(routeFor("/acme/rocket/issues/new"), "/work/new?workspace=acme&repo=rocket");
  assert.equal(routeFor("/acme/rocket/issues/12/edit"), null);
});

test("Code's pages open the app's Code", () => {
  assert.equal(routeFor("/acme/rocket"), "/code/acme/rocket");
  assert.equal(routeFor("/acme/rocket/pull/14"), "/code/acme/rocket/pull/14");
  assert.equal(routeFor("/acme/-/overview"), "/code?workspace=acme");
  assert.equal(routeFor("/acme/rocket/pull/14/files"), null);
  assert.equal(routeFor("/acme/rocket/sessions"), null);
});

test("#N is read where it was written, owner/name#N in that repository, workspace#N in that workspace", () => {
  const here = { workspace: "acme" };
  assert.deepEqual(refContext(null, here), { workspace: "acme" });
  assert.deepEqual(refContext(null, { repo: "acme/web" }), { repo: "acme/web" });
  assert.deepEqual(refContext("acme/api", here), { repo: "acme/api" });
  assert.deepEqual(refContext("globex", here), { workspace: "globex" });
  assert.equal(refRoute({ workspace: "acme" }, 7), "/ref?workspace=acme&number=7");
  assert.equal(refRoute({ repo: "acme/web" }, 7), "/ref?repo=acme%2Fweb&number=7");
});

test("what a reference names opens its screen, and the site reads one the app cannot", () => {
  assert.equal(targetRoute({ kind: "work_item", workspace: "acme", number: 31, item_id: "wki_1" }), "/work/31?workspace=acme");
  assert.equal(targetRoute({ kind: "pull", repo: "acme/web", number: 9 }), "/code/acme/web/pull/9");
  assert.equal(targetRoute({ kind: "pull", repo: "nonsense", number: 9 }), null);
  assert.equal(targetRoute({ kind: "none" }), null);
  assert.equal(refSitePath({ repo: "acme/web" }, 9), "/acme/web/issues/9");
  assert.equal(refSitePath({ workspace: "acme" }, 9), "/acme/-/work/9");
});

test("old links to Agents, Customize and the Marketplace open Home", () => {
  assert.equal(routeFor("/acme/-/agents"), "/home?workspace=acme");
  assert.equal(routeFor("/acme/-/agents/skills"), "/home?workspace=acme");
  assert.equal(routeFor("/acme/-/agents/skills/pdf"), "/home?workspace=acme");
  assert.equal(routeFor("/acme/-/customize"), "/home?workspace=acme");
  assert.equal(routeFor("/acme/-/customize/plugins/pdf%40anthropic-agent-skills"), "/home?workspace=acme");
  assert.equal(routeFor("/acme/-/marketplace/integrations"), "/home?workspace=acme");
});

test("the integrations directory stays on the site", () => {
  assert.equal(routeFor("/acme/-/settings/integrations"), null);
  assert.equal(routeFor("/acme/-/settings/integrations/github"), null);
});

test("the app's sign-in comes back to its own screen, and the site's own pages stay on the site", () => {
  assert.equal(routeFor("/oauth/callback?code=c&state=s"), "/oauth/callback?code=c&state=s");
  assert.equal(routeFor("/settings/tokens"), null);
  assert.equal(routeFor("/"), "/");
});

test("a connect link points the app at a g1t", () => {
  assert.equal(routeFor("/connect?server=https%3A%2F%2Fg1t.example.com"), "/connect?server=https%3A%2F%2Fg1t.example.com");
  assert.equal(sitePathOf("g1t://connect?server=https%3A%2F%2Fg1t.example.com"), "/connect?server=https%3A%2F%2Fg1t.example.com");
  // A workspace named connect is still a workspace.
  assert.equal(routeFor("/connect/-/chat"), "/chat?workspace=connect");
  assert.equal(routeFor("/connect/web"), "/code/connect/web");
});
