import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { setTask, taskList, type Task } from "./tasks.ts";

const fixtures = JSON.parse(readFileSync(new URL("./tasks.fixtures.json", import.meta.url), "utf8")) as {
  lists: { body: string; tasks: Task[] }[];
};

test("finds the boxes the work service finds, on every shared case", () => {
  assert.ok(fixtures.lists.length > 10);
  for (const { body, tasks } of fixtures.lists) assert.deepEqual(taskList(body), tasks, JSON.stringify(body));
});

test("ticks only the box on the line, and nothing on a line without one", () => {
  const body = "Steps:\r\n\r\n- [ ] one\r\n  - [X] two\r\n> 1. [ ] three\r\n```\n- [ ] code\n```";
  assert.equal(setTask(body, 3, true), "Steps:\r\n\r\n- [x] one\r\n  - [X] two\r\n> 1. [ ] three\r\n```\n- [ ] code\n```");
  assert.equal(setTask(body, 4, false), "Steps:\r\n\r\n- [ ] one\r\n  - [ ] two\r\n> 1. [ ] three\r\n```\n- [ ] code\n```");
  assert.equal(setTask(body, 7, true), body);
  assert.equal(setTask(body, 1, true), body);
});
