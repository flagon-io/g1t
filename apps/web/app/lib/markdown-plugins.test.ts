import assert from "node:assert/strict";
import { test } from "node:test";

import { G1T_MENTION_HREF, rehypeReferences } from "./markdown-plugins.ts";

type Node = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: Node[] };

/** The links a paragraph of `text` gets: each one's href and text. */
function links(text: string): [string, string][] {
  const tree: Node = { type: "root", children: [{ type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: text }] }] };
  rehypeReferences({ repo: { namespace: "acme", name: "web" } })(tree as never);
  return (tree.children![0]!.children ?? [])
    .filter((node) => node.tagName === "a")
    .map((node) => [String(node.properties!.href), node.children![0]!.value!]);
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

test("issues and pull requests still link", () => {
  assert.deepEqual(links("see #12 and other/repo#3"), [
    ["/acme/web/issues/12", "#12"],
    ["/other/repo/issues/3", "other/repo#3"],
  ]);
});
