import assert from "node:assert/strict";
import { test } from "node:test";

import type { JobLogText } from "@g1t/contracts";

import {
  type StepLog,
  appendLog,
  archiveFiles,
  blocks,
  classify,
  emptyLog,
  fileName,
  groupOf,
  highlight,
  lastStamp,
  logRows,
  readLog,
  rowKey,
  searchLog,
  searchStepLog,
  splitStamp,
} from "./log-lines.ts";

/** `text` read as chunks cut at `cuts` (offsets into it), one at a time. */
function readInChunks(text: string, cuts: number[]): StepLog {
  let log = emptyLog();
  let at = 0;
  for (const cut of [...cuts, text.length]) {
    log = appendLog(log, text.slice(at, cut));
    at = cut;
  }
  return log;
}

/** What a log holds, for comparing two ways of reading it. */
function shape(log: StepLog) {
  return { blocks: log.blocks, lines: log.lines, blockOf: log.blockOf, group: log.group, lastAt: log.lastAt, hasText: log.hasText };
}

test("a log read chunk by chunk is the log read at once, wherever the chunks fall", () => {
  const text = [
    "2026-10-12T09:41:07.1000000Z Job: test",
    "2026-10-12T09:41:07.2000000Z ##[group]Run cargo test",
    "2026-10-12T09:41:07.3000000Z cargo test --locked",
    "2026-10-12T09:41:07.4000000Z \u001b[32mok\u001b[0m",
    "2026-10-12T09:41:08.0000000Z ##[endgroup]",
    "2026-10-12T09:41:09.0000000Z ##[error]Process completed with exit code 101.",
    "",
  ].join("\n");
  const whole = readLog(text);
  // Every cut, and many cuts, including inside a line and inside an escape code.
  for (let cut = 0; cut <= text.length; cut++) assert.deepEqual(shape(readInChunks(text, [cut])), shape(whole), `cut at ${cut}`);
  assert.deepEqual(
    shape(
      readInChunks(
        text,
        Array.from({ length: text.length }, (_, i) => i),
      ),
    ),
    shape(whole),
  );
  assert.equal(whole.lastAt, "2026-10-12T09:41:09.0000000Z");
  assert.deepEqual(whole.blocks, blocks(text));
});

test("a group a chunk leaves open holds the next chunk's lines", () => {
  let log = appendLog(emptyLog(), "before\n##[group]Install\none\n");
  assert.equal(log.group, 1);
  log = appendLog(log, "two\n##[endgroup]\nafter\n");
  assert.deepEqual(
    log.blocks.map((block) => (block.kind === "line" ? block.line.text : `${block.title}: ${block.lines.map((entry) => entry.line.text).join(",")}`)),
    ["before", "Install: one,two", "after"],
  );
  assert.equal(log.group, null);
  assert.equal(groupOf(log, 3), 1);
  assert.equal(groupOf(log, 4), null);
});

test("a line still being written shows, and is read once it ends", () => {
  let log = appendLog(emptyLog(), "one\ntw");
  assert.equal(log.lines.length, 1);
  assert.deepEqual(log.tail, { line: { kind: "text", text: "tw" }, number: 2 });
  assert.deepEqual(
    searchStepLog(log, "TW").map((found) => found.number),
    [2],
  );
  log = appendLog(log, "o\n");
  assert.equal(log.tail, undefined);
  assert.deepEqual(
    log.lines.map((entry) => entry.line.text),
    ["one", "two"],
  );
  // A group's marker cut in two opens the group once it is whole.
  log = appendLog(log, "##[gro");
  assert.equal(log.tail, undefined, "half a marker is not a line");
  log = appendLog(log, "up]Later\nthree\n");
  assert.equal(groupOf(log, 3), 2);
  assert.equal(readLog("   \n\n").hasText, false);
});

test("reading a long log chunk by chunk reads each line once", () => {
  const line = (n: number) => `2026-10-12T09:41:07.0000000Z ${n % 500 === 0 ? "##[group]Batch" : n % 500 === 20 ? "##[endgroup]" : `test case_${n} ... ok`}\n`;
  let log = emptyLog();
  const started = performance.now();
  for (let chunk = 0; chunk < 500; chunk++) {
    let text = "";
    for (let n = chunk * 100; n < chunk * 100 + 100; n++) text += line(n);
    log = appendLog(log, text);
  }
  const took = performance.now() - started;
  assert.equal(log.lines.length, 50_000 - 200);
  // Reading the whole text again for every chunk took about 25 s here.
  assert.ok(took < 2000, `50,000 lines in 500 chunks took ${Math.round(took)} ms`);
});

test("a log's rows are its lines and groups' titles, open groups' lines under them", () => {
  const log = readLog("a\n##[group]G\nb\nc\n##[endgroup]\nd\n");
  const keys = (open: number[]) => logRows(log, new Set(open)).map(rowKey);
  assert.deepEqual(keys([]), ["L1", "G1", "L4"]);
  assert.deepEqual(keys([1]), ["L1", "G1", "L2", "L3", "L4"]);
  assert.deepEqual(logRows(log, new Set())[1], { kind: "group", block: 1, title: "G", at: undefined, open: false, size: 2 });
  // A search reads a log once a change.
  assert.equal(searchStepLog(log, "b"), searchStepLog(log, " B "));
});

const LOG = [
  "Job: test",
  "##[group]Run cargo test",
  "cargo test --locked",
  "##[endgroup]",
  "test greet ... FAILED",
  "##[error]Process completed with exit code 101.",
].join("\n");

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
  const files = archiveFiles([
    job("test", [
      [0, "set up\n"],
      [1, "running\n"],
      [1, "ok\n"],
    ]),
    job("deploy/x", [], true),
  ]);
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
  assert.deepEqual(parsed[2], {
    kind: "line",
    line: { kind: "error", text: "Process completed with exit code 1.", at: "2026-10-12T09:41:10.0000000Z" },
    number: 3,
  });
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
