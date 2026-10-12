import assert from "node:assert/strict";
import { test } from "node:test";

import type { JobLogText } from "@g1t/contracts";

import { archiveFiles, blocks, classify, fileName, highlight, lastStamp, searchLog, splitStamp } from "./log-lines.ts";

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

test("each line's time comes off the front, as GitHub's logs stamp it, and colours stay beside the plain text", () => {
  const stamped = [
    "2026-10-12T09:41:07.1234567Z ##[group]Run cargo build",
    "2026-10-12T09:41:07.2000000Z \u001b[36;1mcargo build\u001b[0m",
    "2026-10-12T09:41:07.3000000Z ##[endgroup]",
    "2026-10-12T09:41:09.0000000Z \u001b[1m\u001b[32m   Compiling\u001b[0m g1t v0.2.0",
    "2026-10-12T09:41:10.0000000Z ##[error]Process completed with exit code 1.",
    "a line from before lines were stamped",
    "",
  ].join("\n");
  const parsed = blocks(stamped);
  assert.equal(parsed.length, 4, "a log's last newline adds no line");
  assert.deepEqual(parsed[0], {
    kind: "group",
    title: "Run cargo build",
    at: "2026-10-12T09:41:07.1234567Z",
    lines: [{ line: { kind: "text", text: "cargo build", at: "2026-10-12T09:41:07.2000000Z", ansi: "\u001b[36;1mcargo build\u001b[0m" }, number: 1 }],
  });
  assert.deepEqual(parsed[1], {
    kind: "line",
    line: { kind: "text", text: "   Compiling g1t v0.2.0", at: "2026-10-12T09:41:09.0000000Z", ansi: "\u001b[1m\u001b[32m   Compiling\u001b[0m g1t v0.2.0" },
    number: 2,
  });
  assert.deepEqual(parsed[2], { kind: "line", line: { kind: "error", text: "Process completed with exit code 1.", at: "2026-10-12T09:41:10.0000000Z" }, number: 3 });
  assert.deepEqual(parsed[3], { kind: "line", line: { kind: "text", text: "a line from before lines were stamped" }, number: 4 });
  // Search reads the plain text, never the time or the codes.
  assert.deepEqual(
    searchLog(stamped, "compiling g1t").map((found) => found.number),
    [2],
  );
  assert.deepEqual(searchLog(stamped, "2026-10-12"), []);
  assert.deepEqual(searchLog(stamped, "32m"), []);
  assert.deepEqual(splitStamp("2026-10-12T09:41:07Z text"), { at: "2026-10-12T09:41:07Z", rest: "text" });
  assert.deepEqual(splitStamp("2026-10-12 not a stamp"), { rest: "2026-10-12 not a stamp" });
  assert.deepEqual(classify("##[warning]plain"), { kind: "warning", text: "plain" });
  assert.equal(lastStamp(stamped), "2026-10-12T09:41:10.0000000Z");
  assert.equal(lastStamp("no stamps\n"), undefined);
});
