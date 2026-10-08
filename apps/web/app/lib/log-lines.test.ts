import assert from "node:assert/strict";
import { test } from "node:test";

import type { JobLogText } from "@g1t/contracts";

import { archiveFiles, blocks, fileName, highlight, searchLog } from "./log-lines.ts";

const LOG = ["Job: test", "##[group]Run cargo test", "cargo test --locked", "##[endgroup]", "test greet ... FAILED", "##[error]Process completed with exit code 101."].join("\n");

test("a log reads as lines and folded groups, numbered past the group markers", () => {
  const parsed = blocks(LOG);
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed[1], { kind: "group", title: "Run cargo test", lines: [{ line: { kind: "text", text: "cargo test --locked" }, number: 2 }] });
  assert.deepEqual(parsed[3], { kind: "line", line: { kind: "error", text: "Process completed with exit code 101." }, number: 4 });
});

test("search finds lines in any case, inside folded groups too", () => {
  assert.deepEqual(
    searchLog(LOG, "CARGO TEST").map((found) => found.number),
    [2],
  );
  assert.deepEqual(
    searchLog(LOG, "test").map((found) => found.number),
    [1, 2, 3],
  );
  assert.deepEqual(searchLog(LOG, "   "), []);
  // The group's title is not a line of its own.
  assert.deepEqual(searchLog(LOG, "Run cargo"), []);
});

test("matches are marked where they fall", () => {
  assert.deepEqual(highlight("Test a test", "test"), [
    { text: "Test", match: true },
    { text: " a ", match: false },
    { text: "test", match: true },
  ]);
  assert.deepEqual(highlight("plain", ""), [{ text: "plain", match: false }]);
});

test("a run's archive has each job whole and a file per step, named as the API names them", () => {
  const job = (name: string, chunks: [number, string][], omitted = false): JobLogText => ({
    jobId: "job_1",
    name,
    steps: [{ number: 1, name: "Run cargo test", status: "completed", conclusion: "success", startedAt: null, finishedAt: null }],
    chunks: chunks.map(([step, text], index) => ({ seq: index + 1, step, text })),
    done: true,
    omitted,
  });
  const files = archiveFiles([job("test", [[0, "set up\n"], [1, "running\n"], [1, "ok\n"]]), job("deploy/x", [], true)]);
  assert.deepEqual(
    files.map((file) => file.path),
    ["1_test.txt", "test/0_Set up job.txt", "test/1_Run cargo test.txt", "2_deploy_x.txt"],
  );
  assert.equal(files[0]!.text, "set up\nrunning\nok\n");
  assert.equal(files[2]!.text, "running\nok\n");
  assert.match(files[3]!.text, /left out/);
  assert.equal(fileName("build / a:b"), "build _ a_b");
  assert.equal(fileName(".."), "job");
});
