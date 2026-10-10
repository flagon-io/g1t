import assert from "node:assert/strict";
import { test } from "node:test";

import { gather, homeKey, ndjson, outcomeLine, transcriptOf } from "./computer-shape.ts";

test("a computer's home is kept under one key per agent", () => {
  assert.equal(homeKey("agt_1"), "homes/agt_1.tar.zst");
});

test("lines gather in order and stop at the cap", () => {
  const lines = [
    { stream: "stdout", line: "one" },
    { stream: "stderr", line: "two" },
    { stream: "stdout", line: "three" },
  ];
  assert.deepEqual(gather(lines), { output: "one\ntwo\nthree", truncated: false });
  assert.deepEqual(gather(lines, 7), { output: "one\ntwo", truncated: true });
  assert.deepEqual(gather([]), { output: "", truncated: false });
});

test("how a command ended reads as one line", () => {
  assert.equal(outcomeLine({ exit_code: 0, duration_ms: 1234, timed_out: false, truncated: false }), "exit 0 · 1.2 s");
  assert.equal(outcomeLine({ exit_code: 1, duration_ms: 42_000, timed_out: false, truncated: true }), "exit 1 · 42 s · output cut");
  assert.equal(outcomeLine({ exit_code: 124, duration_ms: 300_000, timed_out: true, truncated: false }), "exit 124 · 5 min · timed out");
});

test("a transcript carries the closing note, or says the computer stopped answering", () => {
  const lines = [{ stream: "stdout", line: "hello" }];
  const plain = transcriptOf(lines, { exit_code: 0, duration_ms: 10 }, null);
  assert.equal(plain.output, "hello");
  assert.equal(plain.exit_code, 0);
  assert.equal(plain.duration_ms, 10);
  const cut = transcriptOf(lines, { exit_code: 0, duration_ms: 10, truncated: true, note: "Output past 1.0 MB was dropped: 5 more bytes." }, null);
  assert.equal(cut.output, "hello\n[Output past 1.0 MB was dropped: 5 more bytes.]");
  assert.equal(cut.truncated, true);
  const gone = transcriptOf(lines, null, "connection reset");
  assert.equal(gone.exit_code, -1);
  assert.equal(gone.duration_ms, null);
  assert.equal(gone.output, "hello\n[The computer stopped answering: connection reset.]");
  assert.equal(transcriptOf([], null, null).output, "[The computer stopped answering.]");
});

test("NDJSON is read line by line across chunks, skipping what is not an object", async () => {
  const parts = ['{"stream":"stdout","li', 'ne":"a"}\n{"stream":"stderr","line":"b"}\nnot json\n[1]\n{"exit_code":0,"duration_ms":5}'];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
  const seen: Record<string, unknown>[] = [];
  for await (const line of ndjson(body)) seen.push(line);
  assert.deepEqual(seen, [
    { stream: "stdout", line: "a" },
    { stream: "stderr", line: "b" },
    { exit_code: 0, duration_ms: 5 },
  ]);
});
