import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { rehypeTaskLines } from "./markdown-plugins.ts";
import { markdownTree } from "./markdown-tree.ts";
import { taskCheckOf } from "./task-check.ts";
import { taskList } from "@g1t/contracts/tasks";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

test("reads the box a form names", () => {
  assert.deepEqual(taskCheckOf(form({ task: "2", expected: "Write the docs", checked: "1" })), { task: 2, expected: "Write the docs", checked: true });
  assert.deepEqual(taskCheckOf(form({ task: "3", checked: "" })), { task: 3, checked: false });
  // Nothing usable is left out, for the work service to refuse.
  assert.deepEqual(taskCheckOf(form({ task: "0" })), { checked: false });
  assert.deepEqual(taskCheckOf(form({ task: "two", checked: "1" })), { checked: true });
});

/** The line each box markdown draws says, in order, as the site renders it. */
function drawnLines(source: string): (number | undefined)[] {
  const tree = markdownTree(source, {
    remarkPlugins: [remarkGfm],
    rehypePlugins: [rehypeRaw, [rehypeSanitize, defaultSchema], rehypeTaskLines],
  });
  const lines: (number | undefined)[] = [];
  visit(tree, "element", (node) => {
    if (node.tagName === "input") lines.push(node.properties.dataTaskLine as number | undefined);
  });
  return lines;
}

test("each box markdown draws is a box the work service counts, on its line", () => {
  const source = [
    "Intro",
    "",
    "- [ ] one",
    "  - [x] nested",
    "- plain",
    "",
    "> - [ ] quoted",
    "",
    "```",
    "- [ ] code",
    "```",
    "",
    "1. [X] numbered",
    "",
    "- [ ] loose",
    "",
    "- [x] list",
  ].join("\n");
  const drawn = drawnLines(source);
  assert.deepEqual(drawn, [3, 4, 7, 13, 15, 17]);
  assert.deepEqual(
    taskList(source).map((task) => task.line),
    drawn,
  );
});

test("markdown draws the boxes of every shared case where the work service counts them", () => {
  const fixtures = JSON.parse(readFileSync(new URL("../../../../packages/contracts/src/tasks.fixtures.json", import.meta.url), "utf8")) as {
    lists: { body: string; tasks: { line: number }[] }[];
  };
  for (const { body, tasks } of fixtures.lists) {
    assert.deepEqual(
      drawnLines(body),
      tasks.map((task) => task.line),
      JSON.stringify(body),
    );
  }
});

test("a box written as HTML only shows", () => {
  assert.deepEqual(drawnLines('<ul><li class="task-list-item"><input type="checkbox" checked> by hand</li></ul>\n\n- [ ] by markdown'), [undefined, 3]);
});
