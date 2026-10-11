import assert from "node:assert/strict";
import { test } from "node:test";

import { routeFor, sitePathOf } from "./links.ts";

test("a g1t:// link names a site path, as on the desktop", () => {
  assert.equal(sitePathOf("g1t://acme/-/chat/dm/chn_1"), "/acme/-/chat/dm/chn_1");
  assert.equal(sitePathOf("g1t:///acme/rocket/pull/3?tab=files"), "/acme/rocket/pull/3?tab=files");
  assert.equal(sitePathOf("https://g1t.sh/acme"), null);
});

test("Chat's pages open the app's Chat", () => {
  assert.equal(routeFor("/acme/-/chat"), "/chat?workspace=acme");
  assert.equal(routeFor("/acme/-/chat/general"), "/chat/general?workspace=acme");
  assert.equal(routeFor("/acme/-/chat/dm/chn_1"), "/chat/chn_1?workspace=acme");
  assert.equal(routeFor("/acme/-/chat/browse"), null);
});

test("Code's pages open the app's Code", () => {
  assert.equal(routeFor("/acme/rocket"), "/code/acme/rocket");
  assert.equal(routeFor("/acme/rocket/pull/14"), "/code/acme/rocket/pull/14");
  assert.equal(routeFor("/acme/rocket/issues/12"), "/code/acme/rocket/issues/12");
  assert.equal(routeFor("/acme/-/overview"), "/code?workspace=acme");
  assert.equal(routeFor("/acme/rocket/pull/14/files"), null);
  assert.equal(routeFor("/acme/rocket/issues/new"), null);
});

test("the Marketplace, integrations and skills open Customize", () => {
  assert.equal(routeFor("/acme/-/marketplace/integrations"), "/customize?workspace=acme");
  assert.equal(routeFor("/acme/-/agents/skills"), "/customize?workspace=acme");
});

test("the app's sign-in comes back to its own screen, and the site's own pages stay on the site", () => {
  assert.equal(routeFor("/oauth/callback?code=c&state=s"), "/oauth/callback?code=c&state=s");
  assert.equal(routeFor("/settings/tokens"), null);
  assert.equal(routeFor("/"), "/");
});
