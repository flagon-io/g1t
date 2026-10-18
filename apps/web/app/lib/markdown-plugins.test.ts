import assert from "node:assert/strict";
import { test } from "node:test";

import { G1T_MENTION_HREF, rehypeReferences } from "./markdown-plugins.ts";

type Node = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: Node[] };

/** The links a paragraph of `text` gets: each one's href and text. */
function links(text: string): [string, string][] {
  const tree: Node = { type: "root", children: [{ type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: text }] }] };
  rehypeReferences({ repo: { namespace: "acme", name: "web" } })(tree as never);
  return (tree.children![0]!.children ?? []).filter((node) => node.tagName === "a").map((node) => [String(node.properties!.href), node.children![0]!.value!]);
}

test("@name links to the person or workspace", () => {
  assert.deepEqual(links("thanks @Ana."), [["/ana", "@Ana"]]);
  assert.deepEqual(links("me@example.com"), []);
});

test("@g1t is g1t's agent, never the workspace alias at /g1t", () => {
  assert.deepEqual(links("@g1t fix this, then ask @G1T again"), [
    [G1T_MENTION_HREF, "@g1t"],
    [G1T_MENTION_HREF, "@G1T"],
  ]);
  assert.ok(!G1T_MENTION_HREF.startsWith("/"));
  // Names that only start with g1t are anyone's.
  assert.deepEqual(links("@g1t-fans"), [["/g1t-fans", "@g1t-fans"]]);
});

test("@workspace/team links to the team", () => {
  assert.deepEqual(links("cc @acme/backend, @ana"), [
    ["/acme/-/teams/backend", "@acme/backend"],
    ["/ana", "@ana"],
  ]);
  assert.deepEqual(links("(@Acme/Web-Platform)"), [["/acme/-/teams/web-platform", "@Acme/Web-Platform"]]);
});

/** The links a paragraph of `text` gets, read in `options`' repository or workspace. */
function linksIn(text: string, options: { repo?: { namespace: string; name: string }; workspace?: string }): [string, string][] {
  const tree: Node = { type: "root", children: [{ type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: text }] }] };
  rehypeReferences(options)(tree as never);
  return (tree.children![0]!.children ?? []).filter((node) => node.tagName === "a").map((node) => [String(node.properties!.href), node.children![0]!.value!]);
}

test("#12 in a repository is read there, by the page that asks the work service", () => {
  // Its pull request, the work item its issue became, the workspace's work
  // item or another repository's pull request: lib/refs.ts says which page asks.
  assert.deepEqual(links("see #12 and other/repo#3"), [
    ["/acme/web/ref/12", "#12"],
    ["/other/repo/ref/3", "other/repo#3"],
  ]);
});

test("#12 in a workspace's text is its work item, and workspace#12 is that workspace's", () => {
  assert.deepEqual(linksIn("see #12, beta#4 and beta/api#7", { workspace: "acme" }), [
    ["/acme/-/work/12", "#12"],
    ["/beta/-/work/4", "beta#4"],
    ["/beta/api/ref/7", "beta/api#7"],
  ]);
  // A repository's text reads `workspace#12` in that workspace too.
  assert.deepEqual(links("Part of acme#9"), [["/acme/-/work/9", "acme#9"]]);
});

test("#12 with nowhere to read it stays text, and so does a link's fragment", () => {
  assert.deepEqual(linksIn("see #12", {}), []);
  assert.deepEqual(linksIn("see /docs#12 and ##3", { workspace: "acme" }), []);
});
