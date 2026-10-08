import assert from "node:assert/strict";
import { test } from "node:test";

import { rehypeReferences } from "./markdown-plugins.ts";

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
